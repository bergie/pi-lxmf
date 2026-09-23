/**
 * @file quota.js
 *
 * z.ai (GLM Coding Plan) quota watcher + peak-hours warning (work doc #3).
 *
 * Two related behaviours, both gated on the active model being a z.ai GLM
 * model (`provider === "zai"`):
 *
 * 1. **Quota-recovery notification.** When a run fails with a z.ai
 *    quota-exhausted error, poll the z.ai quota endpoint and push exactly
 *    one LXMF message to the owner the moment the 5h bucket becomes
 *    available again, so the owner can resume work without babysitting it.
 *
 * 2. **Peak-hours warning.** z.ai charges 3× tokens during peak hours
 *    (Mon–Fri 14:00–18:00 Singapore Standard Time, UTC+8). Warn the owner
 *    when an owner-triggered run starts inside that window, and when the
 *    window opens mid-run, so they can decide whether to stop or continue.
 *
 * The quota endpoint and auth-file layout mirror `pi-glm-usage`
 * (`https://api.z.ai/api/monitor/usage/quota/limit`, Bearer
 * `~/.pi/agent/auth.json` → `zai.key`). Missing key disables the watcher
 * gracefully (logged once, never thrown).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** z.ai quota endpoint (same one `pi-glm-usage` calls). */
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
/** Fetch timeout for the quota endpoint (ms). */
const FETCH_TIMEOUT_MS = 5000;
/** Poll cadence while the 5h bucket is exhausted (ms). */
const POLL_INTERVAL_MS = 60_000;

/**
 * z.ai peak window: Monday–Friday, 14:00–18:00 Singapore Standard Time
 * (UTC+8) → 06:00–10:00 UTC. Token usage costs 3× during this window.
 *
 * `START_UTC_HOUR` inclusive, `END_UTC_HOUR` exclusive.
 */
const PEAK_START_UTC_HOUR = 6;
const PEAK_END_UTC_HOUR = 10;
/** Days the peak window applies (0=Sun … 6=Sat), in UTC (the window is
 * 06:00–10:00 UTC, which is the same calendar day in SGT). */
const PEAK_DAYS = new Set([1, 2, 3, 4, 5]); // Mon–Fri

/** Quota limit `unit` values (mirrors `pi-glm-usage`'s mapping). */
const Unit = {
  /** 5 Hours Quota (TOKENS_LIMIT). */
  FIVE_HOUR: 3,
  /** Weekly Quota (TOKENS_LIMIT). */
  WEEKLY: 6,
  /** Monthly Web Search/Reader/Zread (TIME_LIMIT) — parsed, not watched. */
  MONTHLY: 5,
};

/**
 * The 5h bucket is treated as exhausted at-or-above this percentage.
 */
const EXHAUSTED_PERCENTAGE = 100;

/** z.ai provider id (and its `z.ai` alias, defensively). */
const ZAI_PROVIDERS = new Set(["zai", "z.ai"]);

/**
 * @param {any} model - The active model object from `get_state`/`get_available_models`.
 * @returns {boolean} `true` when the model is a z.ai GLM model.
 */
export function isZaiModel(model) {
  const provider =
    model && typeof model === "object" ? model.provider : undefined;
  return (
    typeof provider === "string" &&
    ZAI_PROVIDERS.has(provider.trim().toLowerCase())
  );
}

/**
 * Reads the z.ai API key from the configured auth file, honouring
 * `PI_AUTH_DIR` (like `pi-glm-usage`), falling back to
 * `~/.pi/agent/auth.json`.
 *
 * @param {string} [authDir] - Override directory (defaults to `$PI_AUTH_DIR`
 *   then `~/.pi/agent`).
 * @returns {string|null} The API key, or `null` when absent/unreadable.
 */
export function readZaiKey(authDir) {
  const dir =
    authDir ||
    (typeof process !== "undefined" && process.env?.PI_AUTH_DIR) ||
    join(homedir(), ".pi", "agent");
  const file = join(dir, "auth.json");
  try {
    if (!existsSync(file)) return null;
    const auth = JSON.parse(readFileSync(file, "utf8"));
    const key = auth?.zai?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

/**
 * Fetches and parses quota data from the z.ai API.
 *
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<{fiveHour: {percentage: number, nextResetMs: number}|null, weekly: {percentage: number, nextResetMs: number}|null, level: string|null}>}
 * @throws {Error} on network/HTTP/structural failure.
 */
export async function fetchQuota(apiKey, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(QUOTA_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: options.signal ?? controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data?.code !== 200 || !Array.isArray(data?.data?.limits)) {
      throw new Error("invalid quota response");
    }
    /** @type {any} */
    let fiveHour = null;
    /** @type {any} */
    let weekly = null;
    for (const limit of data.data.limits) {
      if (limit.unit === Unit.FIVE_HOUR) fiveHour = limit;
      else if (limit.unit === Unit.WEEKLY) weekly = limit;
    }
    return {
      fiveHour: fiveHour
        ? {
            percentage: Number(fiveHour.percentage) || 0,
            nextResetMs: Number(fiveHour.nextResetTime) || 0,
          }
        : null,
      weekly: weekly
        ? {
            percentage: Number(weekly.percentage) || 0,
            nextResetMs: Number(weekly.nextResetTime) || 0,
          }
        : null,
      level: typeof data.data.level === "string" ? data.data.level : null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Returns `true` when the given error message looks like a z.ai
 * quota-exhausted failure (the signal that arms the watcher).
 *
 * Deliberately permissive: this is a "maybe exhausted, go check" signal,
 * not an admission decision — the authoritative answer comes from
 * {@link fetchQuota}, and a false positive costs only one quota fetch.
 * Rate-limit-only messages (no quota wording) are excluded: those are
 * transient and pi already retries them automatically.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function looksLikeQuotaError(message) {
  const m = String(message ?? "").toLowerCase();
  if (!m) return false;
  return /\bquota\b|usage[\s-]?limit|\bbalance\b|insufficient/.test(m);
}

/**
 * Reports whether a point in time falls inside the z.ai peak window
 * (Mon–Fri 14:00–18:00 SGT / 06:00–10:00 UTC).
 *
 * @param {number} epochMs - Unix epoch milliseconds.
 * @returns {boolean}
 */
export function isPeakTime(epochMs) {
  const d = new Date(epochMs);
  const dayUtc = d.getUTCDay();
  if (!PEAK_DAYS.has(dayUtc)) return false;
  const hourUtc = d.getUTCHours();
  return hourUtc >= PEAK_START_UTC_HOUR && hourUtc < PEAK_END_UTC_HOUR;
}

/**
 * Milliseconds until the next peak-window open (or 0 when already inside
 * the window). Used to schedule a "run ran into peak" warning.
 *
 * @param {number} fromMs - Unix epoch milliseconds.
 * @returns {number} ms until the window opens, or 0 if inside it.
 */
export function msUntilPeakOpen(fromMs) {
  if (isPeakTime(fromMs)) return 0;
  const from = new Date(fromMs);
  // Walk forward hour by hour (max ~7 days) to the first peak hour.
  for (let h = 0; h < 24 * 7; h++) {
    const probe = new Date(fromMs + h * 3_600_000);
    const d = new Date(
      Date.UTC(
        probe.getUTCFullYear(),
        probe.getUTCMonth(),
        probe.getUTCDate(),
        probe.getUTCHours(),
        0,
        0,
        0,
      ),
    );
    if (
      PEAK_DAYS.has(d.getUTCDay()) &&
      d.getUTCHours() >= PEAK_START_UTC_HOUR &&
      d.getUTCHours() < PEAK_END_UTC_HOUR
    ) {
      return d.getTime() - fromMs;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The z.ai quota watcher + peak-hours warner. Construct one per bridge;
 * drive it with {@link GlmQuotaWatcher.setEnabled} (gated on the active
 * model) and {@link GlmQuotaWatcher.onAgentStart} / {@link
 * GlmQuotaWatcher.onAgentSettled} / {@link GlmQuotaWatcher.onError}.
 */
export class GlmQuotaWatcher {
  /**
   * @param {object} options
   * @param {string} options.ownerDestinationHash - Owner's `lxmf.delivery` hex.
   * @param {(destHex: string, text: string) => Promise<void>} options.sendText - LXMF delivery sink (best-effort).
   * @param {{log: (msg: string) => void, error: (msg: string) => void}} [options.log]
   * @param {string|null} [options.apiKey] - z.ai key; `null` disables the watcher.
   * @param {typeof fetch} [options.fetchImpl] - Injectable fetch (tests).
   * @param {() => number} [options.now] - Injectable clock (tests).
   * @param {number} [options.pollIntervalMs]
   */
  constructor(options) {
    this.ownerDestinationHash = options.ownerDestinationHash;
    this.sendText = options.sendText;
    this.log = options.log || { log: () => {}, error: () => {} };
    this.apiKey = options.apiKey ?? null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

    /** Whether the active model is a z.ai GLM model (the master gate). */
    this.enabled = false;
    /** A run is currently in progress (between agent_start and settled). */
    this.runActive = false;
    /** Whether the current run is owner-triggered (not recovery). */
    this.ownerTriggered = false;
    /** Single active quota poller (idempotent start). */
    /** @type {NodeJS.Timeout|null} */
    this.pollTimer = null;
    /** Whether the 5h bucket was exhausted when the poller last sampled. */
    this.wasExhausted = false;
    /** Whether a recovery notification has already been sent for this episode. */
    this.notifiedThisEpisode = false;
    /** Epoch (ms) the exhaustion episode started, for the human-readable delta. */
    this.exhaustedSinceMs = 0;
    /** Whether we've already warned about peak for the current run. */
    this.peakWarnedThisRun = false;
    /** Timer for the "run ran into peak" boundary warning. */
    /** @type {NodeJS.Timeout|null} */
    this.peakOpenTimer = null;

    if (!this.apiKey) {
      this.log.log("pi-lxmf: GLM quota watcher disabled (no zai key)");
    }
  }

  /**
   * Master gate: enable/disable based on whether the active model is z.ai.
   * Disabling stops any active poller and clears run state.
   *
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.stopPoller();
      this.clearPeakOpenTimer();
      this.runActive = false;
      this.ownerTriggered = false;
      this.peakWarnedThisRun = false;
    } else {
      // Gated on at startup: do one quota fetch so a daemon that restarted
      // mid-outage arms the watcher immediately.
      void this.checkAndMaybeArm(false);
    }
  }

  /**
   * Called on `agent_start`. `ownerTriggered` is false for the internal
   * empty-reply recovery run.
   *
   * @param {boolean} ownerTriggered
   */
  onAgentStart(ownerTriggered) {
    this.runActive = true;
    this.ownerTriggered = ownerTriggered;
    this.peakWarnedThisRun = false;
    if (this.enabled && ownerTriggered) this.maybeWarnPeak("run started");
  }

  /** Called on `agent_settled`. */
  onAgentSettled() {
    this.runActive = false;
    this.ownerTriggered = false;
    this.peakWarnedThisRun = false;
    this.clearPeakOpenTimer();
  }

  /**
   * Called when a Pi error event (`auto_retry_end`/`compaction_end`) looks
   * like a quota failure. Arms the poller (idempotent) when enabled.
   *
   * @param {string} errorMessage
   */
  onError(errorMessage) {
    if (!this.enabled || !this.apiKey) return;
    if (!looksLikeQuotaError(errorMessage)) return;
    this.log.log(
      `pi-lxmf: GLM quota error detected, polling for recovery: ${errorMessage}`,
    );
    void this.checkAndMaybeArm(true);
  }

  /**
   * Stops all timers. Call on daemon shutdown.
   */
  stop() {
    this.stopPoller();
    this.clearPeakOpenTimer();
  }

  /**
   * Fetches the quota once and arms the poller if the 5h bucket is
   * exhausted. When `fromError` is true (we were tipped off by a Pi error),
   * arm even if the first fetch is inconclusive (transient API failure).
   *
   * @param {boolean} fromError
   * @returns {Promise<void>}
   */
  async checkAndMaybeArm(fromError) {
    if (!this.enabled || !this.apiKey) return;
    let quota = null;
    try {
      quota = await fetchQuota(this.apiKey, { fetchImpl: this.fetchImpl });
    } catch (e) {
      if (fromError) {
        // A Pi error said quota-exhausted; trust it and arm, polling will
        // confirm the recovery transition.
        this.log.log(
          `pi-lxmf: GLM quota fetch failed (${e instanceof Error ? e.message : e}); arming watcher on Pi error signal`,
        );
        this.armWatcher(0);
      }
      return;
    }
    const pct = quota.fiveHour?.percentage ?? 0;
    if (pct >= EXHAUSTED_PERCENTAGE) {
      this.armWatcher(pct);
    } else if (this.wasExhausted) {
      // Recovered between fetches (e.g. daemon was away): notify now.
      this.notifyRecovered(quota);
    }
  }

  /**
   * Arms the single poller (idempotent). Records the episode start time on
   * the first arm of an episode and resets the per-episode notification flag.
   *
   * @param {number} percentage
   */
  armWatcher(percentage) {
    if (!this.wasExhausted) {
      this.wasExhausted = true;
      this.exhaustedSinceMs = this.now();
      this.notifiedThisEpisode = false;
      this.log.log(
        `pi-lxmf: GLM 5h quota exhausted (${percentage}%) — will notify on recovery`,
      );
    }
    this.startPoller();
  }

  /** Starts the poller if not already running. */
  startPoller() {
    if (this.pollTimer || !this.enabled || !this.apiKey) return;
    const apiKey = this.apiKey;
    const tick = async () => {
      try {
        const quota = await fetchQuota(apiKey, {
          fetchImpl: this.fetchImpl,
        });
        const pct = quota.fiveHour?.percentage ?? 0;
        if (pct < EXHAUSTED_PERCENTAGE && this.wasExhausted) {
          this.notifyRecovered(quota);
        }
      } catch {
        /* transient — retry on the next tick */
      }
    };
    this.pollTimer = setInterval(() => void tick(), this.pollIntervalMs);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
  }

  /** Stops the poller. */
  stopPoller() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Delivers the one-shot recovery notification and stops the poller.
   *
   * @param {{fiveHour?: {percentage: number}|null, weekly?: {percentage: number}|null, level?: string|null}} quota
   */
  async notifyRecovered(quota) {
    if (this.notifiedThisEpisode) return;
    this.notifiedThisEpisode = true;
    this.wasExhausted = false;
    this.stopPoller();
    const elapsed = this.exhaustedSinceMs
      ? this.now() - this.exhaustedSinceMs
      : 0;
    const weeklyPct = quota.weekly?.percentage;
    const level = quota.level ? `GLM ${quota.level}` : "GLM";
    const parts = [`${level} 5h quota available again`];
    if (elapsed > 0) {
      parts.push(`(was exhausted for ~${formatElapsed(elapsed)})`);
    }
    if (typeof weeklyPct === "number") {
      parts.push(`Weekly: ${weeklyPct}%`);
    }
    try {
      await this.sendText(this.ownerDestinationHash, parts.join(" "));
    } catch (e) {
      this.log.error(
        `pi-lxmf: GLM quota notification delivery failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Sends a peak-hours warning if currently in the window (once per run).
   * Also schedules the "run ran into peak" boundary warning.
   *
   * @param {string} reason - Short reason for the log line.
   */
  maybeWarnPeak(reason) {
    if (!this.enabled) return;
    const nowMs = this.now();
    if (isPeakTime(nowMs)) {
      if (this.peakWarnedThisRun) return;
      this.peakWarnedThisRun = true;
      this.log.log(`pi-lxmf: GLM peak-hours warning (${reason})`);
      void this.sendText(
        this.ownerDestinationHash,
        "⚠️ z.ai peak hours (Mon–Fri 14:00–18:00 SGT): token usage costs 3×. Stop or continue?",
      );
    } else if (this.runActive) {
      // Schedule a warning for when the window opens, if this run is still
      // active then.
      this.clearPeakOpenTimer();
      const ms = msUntilPeakOpen(nowMs);
      if (Number.isFinite(ms) && ms > 0) {
        const fire = () => {
          this.peakOpenTimer = null;
          if (!this.runActive || this.peakWarnedThisRun) return;
          this.peakWarnedThisRun = true;
          this.log.log(
            "pi-lxmf: GLM peak-hours warning (window opened mid-run)",
          );
          void this.sendText(
            this.ownerDestinationHash,
            "⚠️ z.ai peak hours now (Mon–Fri 14:00–18:00 SGT): token usage costs 3×. Stop or continue?",
          );
        };
        this.peakOpenTimer = setTimeout(fire, ms);
        if (typeof this.peakOpenTimer.unref === "function")
          this.peakOpenTimer.unref();
      }
    }
  }

  /** Clears the scheduled peak-open timer. */
  clearPeakOpenTimer() {
    if (this.peakOpenTimer) {
      clearTimeout(this.peakOpenTimer);
      this.peakOpenTimer = null;
    }
  }
}

/** @param {number} ms */
function formatElapsed(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}
