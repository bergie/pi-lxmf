/**
 * @file quota.js
 *
 * z.ai (GLM Coding Plan) quota watcher + peak-hours warning (work doc #3).
 *
 * Three related behaviours, all gated on the active model being a z.ai GLM
 * model (`provider === "zai"`):
 *
 * 1. **Continuous quota sampling.** While a GLM model is active, the same
 *    z.ai quota endpoint `pi-glm-usage` uses is polled every 60s. From
 *    those samples the owner is notified of:
 *    - **Exhaustion** (once per episode): a bucket (5h or weekly) reaches
 *      100% — including at startup, when a daemon restarts mid-outage.
 *    - **90% warning** (once per bucket window): a bucket crosses 90%,
 *      while still below 100%.
 *    - **Recovery** (once per episode): the 5h bucket drops below 100%
 *      after an exhausted episode.
 *    Per-sample notifications are joined into a single LXMF message and
 *    deferred to `agent_settled` while an owner-triggered run is live.
 *
 * 2. **Quota-error arming.** A Pi error that looks like a z.ai
 *    quota-exhausted failure (`auto_retry_end`/`compaction_end`) arms the
 *    poller immediately, even when the live fetch is momentarily
 *    inconclusive — the authoritative answer is the next sample.
 *
 * 3. **Peak-hours warning.** z.ai charges 3× tokens during peak hours
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
/** Sampling cadence while a GLM model is active (ms). */
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
 * A bucket is treated as exhausted at-or-above this percentage.
 */
const EXHAUSTED_PERCENTAGE = 100;
/** Warning threshold (crossing upward, while not exhausted). */
const WARN_PERCENTAGE = 90;

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
 * A live or pinned quota sample for one bucket. `percentage` may exceed
 * `WARN_PERCENTAGE`/`EXHAUSTED_PERCENTAGE` by z.ai's rounding; comparisons
 * are inclusive.
 *
 * @typedef {{percentage: number, nextResetMs: number}} BucketSample
 */

/**
 * The z.ai quota watcher + peak-hours warner. Construct one per bridge;
 * drive it with {@link GlmQuotaWatcher.setEnabled} (gated on the active
 * model) and {@link GlmQuotaWatcher.onAgentStart} /
 * {@link GlmQuotaWatcher.onAgentSettled} / {@link GlmQuotaWatcher.onError}.
 *
 * While enabled, a single sampler polls the quota endpoint every
 * `pollIntervalMs` (first sample immediately). Each sample can queue at
 * most one joined notice:
 * - a bucket crossing `WARN_PERCENTAGE` (once per bucket window) queues
 *   a "90%" warning line;
 * - a bucket reaching `EXHAUSTED_PERCENTAGE` (once per bucket episode)
 *   queues an "exhausted" line with the reset time;
 * - the 5h bucket recovering from an exhausted episode (once per episode)
 *   queues a "recovered" line.
 *
 * A run-triggered error ({@link GlmQuotaWatcher.onError}) additionally
 * forces an immediate sample (fresh state over stale-sampler lag).
 * Notices are delivered as one LXMF message per emission — immediately
 * when the bridge is idle, or when the live owner-triggered run settles
 * (so they never interleave with a reply mid-run).
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
   * @param {number} [options.warnPercentage] - Warning threshold (tests).
   */
  constructor(options) {
    this.ownerDestinationHash = options.ownerDestinationHash;
    this.sendText = options.sendText;
    this.log = options.log || { log: () => {}, error: () => {} };
    this.apiKey = options.apiKey ?? null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.warnPercentage = options.warnPercentage ?? WARN_PERCENTAGE;

    /** Whether the active model is a z.ai GLM model (the master gate). */
    this.enabled = false;
    /** A run is currently in progress (between agent_start and settled). */
    this.runActive = false;
    /** Whether the current run is owner-triggered (not recovery). */
    this.ownerTriggered = false;
    /** Single active sampler (idempotent start). */
    /** @type {NodeJS.Timeout|null} */
    this.pollTimer = null;
    /** Whether the 5h bucket was exhausted in the last sample. */
    this.wasExhausted = false;
    /** Epoch (ms) the exhaustion episode started, for the human-readable delta. */
    this.exhaustedSinceMs = 0;
    /**
     * Whether the 90% warning already fired for each bucket in its current
     * window (a window is any contiguous below-100% stretch — a reset to
     * below-warn clears it, an exhausted episode ends it).
     * @type {{fiveHour: boolean, weekly: boolean}}
     */
    this.warned = { fiveHour: false, weekly: false };
    /** Whether an exhausted episode per bucket already notified (its
     * "exhausted" notice is once per episode).
     * @type {{fiveHour: boolean, weekly: boolean}}
     */
    this.exhaustionNotified = { fiveHour: false, weekly: false };
    /** Notices queued while a run is live, delivered on `onAgentSettled`. */
    /** @type {string[]} */
    this.pendingNotices = [];
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
   * Enabling starts the sampler immediately (first sample right away), so
   * an exhausted state at startup or model switch is detected and
   * notified without waiting for a run or an error. Disabling stops all
   * timers, clears run state, and (best-effort) delivers anything already
   * queued — losing queued notices on shutdown is acceptable, but losing
   * them on a model switch is not.
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
      this.flushNotices();
    } else {
      this.startPoller(true);
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
    this.flushNotices();
  }

  /**
   * Called when a Pi error event (`auto_retry_end`/`compaction_end`) looks
   * like a quota failure. Ensures the sampler is running (idempotent) and
   * forces an immediate sample so the exhaustion notice is driven by the
   * authoritative API state, not the sampler's cadence.
   *
   * @param {string} errorMessage
   */
  onError(errorMessage) {
    if (!this.enabled || !this.apiKey) return;
    if (!looksLikeQuotaError(errorMessage)) return;
    this.log.log(
      `pi-lxmf: GLM quota error detected, polling for recovery: ${errorMessage}`,
    );
    this.startPoller();
    void this.tick();
  }

  /**
   * Stops all timers. Call on daemon shutdown.
   */
  stop() {
    this.stopPoller();
    this.clearPeakOpenTimer();
  }

  /**
   * Starts the sampler if not already running. `immediate` also fires one
   * sample right away (startup, model switch, quota error) instead of
   * waiting a full interval.
   *
   * @param {boolean} [immediate]
   * @private
   */
  startPoller(immediate) {
    if (this.pollTimer || !this.enabled || !this.apiKey) return;
    this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
    if (immediate) void this.tick();
  }

  /**
   * One sampler tick: fetch quota, evaluate bucket transitions, queue
   * notices for anything new.
   *
   * @private
   */
  async tick() {
    if (!this.enabled || !this.apiKey) return;
    let quota = null;
    try {
      quota = await fetchQuota(this.apiKey, { fetchImpl: this.fetchImpl });
    } catch {
      /* transient — retry on the next tick */
      return;
    }
    this.evaluateSample(quota);
  }

  /**
   * Turns a fresh quota sample into (at most one) queued notice, based on
   * per-bucket window/episode transitions.
   *
   * @param {{fiveHour?: BucketSample|null, weekly?: BucketSample|null}} quota
   * @private
   */
  evaluateSample(quota) {
    const pct = quota.fiveHour?.percentage ?? 0;
    const weeklyPct = quota.weekly?.percentage ?? 0;
    const exhausted = pct >= EXHAUSTED_PERCENTAGE;
    const weeklyExhausted = weeklyPct >= EXHAUSTED_PERCENTAGE;

    /** @type {string[]} */
    const lines = [];

    // --- 5h bucket ------------------------------------------------------
    if (exhausted) {
      if (!this.wasExhausted) {
        // New exhausted episode: stamp it, re-arm its notices.
        this.wasExhausted = true;
        this.exhaustedSinceMs = this.now();
        this.exhaustionNotified.fiveHour = false;
        // Suppress the 90% warning for the rest of this window: the
        // exhaustion (and its recovery) notices say everything already.
        this.warned.fiveHour = true;
      }
      if (!this.exhaustionNotified.fiveHour) {
        this.exhaustionNotified.fiveHour = true;
        lines.push(
          `⚠️ GLM 5h quota exhausted (100%)${resetSuffix(quota.fiveHour?.nextResetMs, this.now())}`,
        );
      }
    } else {
      if (this.wasExhausted) {
        // Recovered below 100% after an exhausted episode (once per episode).
        this.wasExhausted = false;
        const elapsed = this.exhaustedSinceMs
          ? this.now() - this.exhaustedSinceMs
          : 0;
        lines.push(
          `✅ GLM 5h quota available again${elapsed > 0 ? ` (was exhausted for ~${formatElapsed(elapsed)})` : ""}. Weekly: ${weeklyPct}%.`,
        );
      }
      if (pct < this.warnPercentage) {
        // Below the threshold: re-arm the warning for the next window.
        this.warned.fiveHour = false;
      } else if (!this.warned.fiveHour) {
        // At-or-above the threshold but not exhausted: warn once per window
        // (a dip below the threshold re-arms the warning).
        this.warned.fiveHour = true;
        lines.push(`⚠️ GLM 5h quota at ${pct}% — getting close.`);
      }
    }

    // --- weekly bucket ----------------------------------------------------
    if (weeklyExhausted) {
      if (!this.exhaustionNotified.weekly) {
        this.exhaustionNotified.weekly = true;
        this.warned.weekly = false;
        lines.push(
          `⚠️ GLM weekly quota exhausted (100%)${resetSuffix(quota.weekly?.nextResetMs, this.now())}`,
        );
      }
    } else if (weeklyPct >= this.warnPercentage && !this.warned.weekly) {
      this.warned.weekly = true;
      lines.push(`⚠️ GLM weekly quota at ${weeklyPct}% — getting close.`);
    } else if (weeklyPct < this.warnPercentage) {
      this.warned.weekly = false;
    }

    if (lines.length > 0) {
      this.log.log(`pi-lxmf: GLM quota notice: ${lines.join(" | ")}`);
      this.queueNotice(lines.join("\n"));
    }
  }

  /**
   * Queues a notice; queued notices are delivered when the bridge is idle
   * or, during a live owner-triggered run, on `agent_settled` (never
   * interleaving with a reply mid-run).
   *
   * @param {string} text
   * @private
   */
  queueNotice(text) {
    this.pendingNotices.push(text);
    this.flushNotices();
  }

  /**
   * Delivers queued notices as one message, when no owner-triggered run
   * is live. Delivery is best-effort; a failure is logged once.
   *
   * @private
   */
  flushNotices() {
    if (this.pendingNotices.length === 0) return;
    if (this.runActive && this.ownerTriggered) return;
    const text = this.pendingNotices.join("\n\n");
    this.pendingNotices = [];
    this.sendText(this.ownerDestinationHash, text).catch((e) => {
      this.log.error(
        `pi-lxmf: GLM quota notification delivery failed: ${e instanceof Error ? e.message : e}`,
      );
    });
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

  /** Stops the sampler. */
  stopPoller() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/**
 * Human-readable "resets in" suffix from a bucket's `nextResetMs`.
 *
 * @param {number|undefined} nextResetMs
 * @param {number} nowMs
 * @returns {string}
 */
function resetSuffix(nextResetMs, nowMs) {
  if (!nextResetMs || nextResetMs <= nowMs) return "";
  const ms = nextResetMs - nowMs;
  return ` — resets in ~${formatElapsed(ms)}`;
}

/** @param {number} ms */
function formatElapsed(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}
