/**
 * GLM quota watcher + peak-hours warning tests (work doc #3).
 *
 * Unit tests for the pure helpers and the watcher's state machine,
 * driving it with an injected fetch and a controllable clock so the 60s
 * poll cadence never waits on real time.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GlmQuotaWatcher,
  isPeakTime,
  isZaiModel,
  looksLikeQuotaError,
  msUntilPeakOpen,
  readZaiKey,
} from "../src/quota.js";

const OWNER_DEST = "c".repeat(32);

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds a fake fetch returning the given quota payload.
 * @param {{limits: any[], level?: string}} payload
 * @returns {any}
 */
function fakeFetch(payload) {
  /** @param {string} _url @param {{headers?: any}} [opts] */
  const fn = async (_url, opts) => {
    fn.calls.push({ url: _url, auth: opts?.headers?.Authorization });
    return {
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          limits: payload.limits,
          level: payload.level ?? "pro",
        },
      }),
    };
  };
  /** @type {Array<{url: string, auth: string}>} */
  fn.calls = [];
  return fn;
}

/**
 * @param {number} fiveHourPct
 * @param {number} [weeklyPct]
 * @param {number} [nextReset]
 */
function quotaPayload(fiveHourPct, weeklyPct = 10, nextReset = 0) {
  return {
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        percentage: fiveHourPct,
        nextResetTime: nextReset,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        percentage: weeklyPct,
        nextResetTime: nextReset,
      },
    ],
    level: "pro",
  };
}

/** @returns {{send: any, sent: Array<{destHex: string, text: string}>}} */
function fakeSend() {
  /** @type {Array<{destHex: string, text: string}>} */
  const sent = [];
  /** @param {string} destHex @param {string} text */
  const send = async (destHex, text) => {
    sent.push({ destHex, text });
  };
  return { send, sent };
}

test("isZaiModel gates on provider zai / z.ai only", () => {
  assert.equal(isZaiModel({ provider: "zai", id: "glm-5.3-flash" }), true);
  assert.equal(isZaiModel({ provider: "z.ai" }), true);
  assert.equal(isZaiModel({ provider: "ZAI" }), true);
  assert.equal(isZaiModel({ provider: "cortecs" }), false);
  assert.equal(isZaiModel({ provider: "anthropic" }), false);
  assert.equal(isZaiModel({ id: "glm-5.3" }), false); // no provider
  assert.equal(isZaiModel(null), false);
  assert.equal(isZaiModel(undefined), false);
});

test("looksLikeQuotaError matches quota/balance/usage-limit wording only", () => {
  assert.equal(looksLikeQuotaError("403 quota exceeded"), true);
  assert.equal(looksLikeQuotaError("429 usage limit reached"), true);
  assert.equal(looksLikeQuotaError("API quota exceeded"), true);
  assert.equal(looksLikeQuotaError("insufficient balance"), true);
  assert.equal(
    looksLikeQuotaError("compaction failed: API quota exceeded"),
    true,
  );
  assert.equal(looksLikeQuotaError("out of quota"), true);
  // Transient errors that pi already retries are NOT quota errors.
  assert.equal(looksLikeQuotaError("503 overloaded"), false);
  assert.equal(looksLikeQuotaError("Overloaded"), false);
  assert.equal(looksLikeQuotaError("terminated"), false);
  assert.equal(looksLikeQuotaError("rate limit: too many requests"), false);
  assert.equal(looksLikeQuotaError(""), false);
});

test("isPeakTime: Mon–Fri 06:00–10:00 UTC (14:00–18:00 SGT)", () => {
  // 2026-09-28 is a Monday.
  assert.equal(isPeakTime(Date.UTC(2026, 8, 28, 6, 0, 0)), true);
  assert.equal(isPeakTime(Date.UTC(2026, 8, 28, 9, 59, 0)), true);
  assert.equal(isPeakTime(Date.UTC(2026, 8, 28, 10, 0, 0)), false); // exclusive
  assert.equal(isPeakTime(Date.UTC(2026, 8, 28, 5, 59, 0)), false);
  // Tuesday through Friday.
  assert.equal(isPeakTime(Date.UTC(2026, 9, 2, 7, 0, 0)), true); // Fri
  // Weekend excluded.
  assert.equal(isPeakTime(Date.UTC(2026, 8, 26, 7, 0, 0)), false); // Sat
  assert.equal(isPeakTime(Date.UTC(2026, 8, 27, 7, 0, 0)), false); // Sun
});

test("msUntilPeakOpen schedules to the next weekday 06:00 UTC", () => {
  // Sun 12:00 UTC → Mon 06:00 UTC is 18h.
  const sun = Date.UTC(2026, 8, 27, 12, 0, 0);
  assert.equal(msUntilPeakOpen(sun), 18 * 3_600_000);
  // Inside the window → 0.
  const mon = Date.UTC(2026, 8, 28, 7, 0, 0);
  assert.equal(msUntilPeakOpen(mon), 0);
  // Fri 11:00 UTC (after the window) → Mon 06:00 UTC (Fri→Mon = 3 days - 5h).
  const fri = Date.UTC(2026, 9, 2, 11, 0, 0);
  assert.equal(msUntilPeakOpen(fri), (3 * 24 - 5) * 3_600_000);
});

test("missing zai key disables the watcher without throwing", () => {
  const { sent } = fakeSend();
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: null,
  });
  // Everything is a no-op when disabled by missing key.
  w.setEnabled(true);
  w.onError("403 quota exceeded");
  w.onAgentStart(true);
  assert.equal(w.pollTimer, null);
  assert.equal(sent.length, 0);
});

test("non-zai model: nothing fires", async () => {
  const fetchImpl = fakeFetch(quotaPayload(100, 10));
  const { sent } = fakeSend();
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: "key",
    fetchImpl,
    now: () => Date.UTC(2026, 8, 28, 7, 0, 0), // peak time
    pollIntervalMs: 10,
  });
  // Never enabled (active model is cortecs): errors and agent_start do nothing.
  w.onError("403 quota exceeded");
  w.onAgentStart(true);
  await sleep(20);
  assert.equal(sent.length, 0);
  assert.equal(w.pollTimer, null);
  w.stop();
});

test("quota error on a GLM model arms the watcher; recovery delivers one message", async () => {
  /** @type {{fiveHourPct: number, weeklyPct: number}} */
  const live = { fiveHourPct: 100, weeklyPct: 62 };
  /** @type {any} */
  const fetchImpl = async (
    /** @type {string} */ _url,
    /** @type {{headers?: any}} */ opts,
  ) => {
    fetchImpl.calls.push({ auth: opts?.headers?.Authorization });
    return {
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          limits: quotaPayload(live.fiveHourPct, live.weeklyPct).limits,
          level: "pro",
        },
      }),
    };
  };
  /** @type {Array<{auth: string}>} */
  fetchImpl.calls = [];

  const { sent } = fakeSend();
  const t0 = Date.UTC(2026, 8, 28, 12, 0, 0); // non-peak
  let nowMs = t0;
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: "key",
    fetchImpl: /** @type {any} */ (fetchImpl),
    now: () => nowMs,
    pollIntervalMs: 5,
  });
  w.setEnabled(true); // active model is GLM
  w.onError("403 quota exceeded");
  await sleep(5);
  assert.equal(w.wasExhausted, true);
  assert.ok(w.pollTimer, "poller armed");

  // Recover: advance time + flip the bucket.
  nowMs += 90 * 60_000; // 90 min later
  live.fiveHourPct = 20;
  await sleep(20);
  assert.equal(sent.length, 1, "exactly one recovery notification");
  assert.match(sent[0].text, /5h quota available again/);
  assert.match(sent[0].text, /Weekly: 62%/);
  assert.match(sent[0].text, /1h 30m/);
  assert.equal(w.pollTimer, null, "poller stopped after notify");
  w.stop();
});

test("a second error while the watcher is already running does not start a second watcher or re-notify", async () => {
  const fetchImpl = fakeFetch(quotaPayload(100, 10));
  const { sent } = fakeSend();
  const nowMs = 1000;
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: "key",
    fetchImpl,
    now: () => nowMs,
    pollIntervalMs: 10,
  });
  w.setEnabled(true);
  w.onError("403 quota exceeded");
  await sleep(5);
  const firstTimer = w.pollTimer;
  assert.ok(firstTimer);
  w.onError("429 usage limit reached");
  await sleep(5);
  assert.equal(w.pollTimer, firstTimer, "no second poller");
  assert.equal(sent.length, 0, "no notification while still exhausted");
  w.stop();
});

test("start-of-run peak warning fires once per run during peak hours", async () => {
  const fetchImpl = fakeFetch(quotaPayload(0, 0));
  const { sent } = fakeSend();
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: "key",
    fetchImpl,
    now: () => Date.UTC(2026, 8, 28, 7, 0, 0), // Mon 07:00 UTC = peak
    pollIntervalMs: 10,
  });
  w.setEnabled(true);
  w.onAgentStart(true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /peak hours/);
  // A second run (after settle) warns again.
  w.onAgentSettled();
  w.onAgentStart(true);
  assert.equal(sent.length, 2);
  w.stop();
});

test("recovery run does not trigger a peak warning", async () => {
  const fetchImpl = fakeFetch(quotaPayload(0, 0));
  const { sent } = fakeSend();
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: "key",
    fetchImpl,
    now: () => Date.UTC(2026, 8, 28, 7, 0, 0),
    pollIntervalMs: 10,
  });
  w.setEnabled(true);
  w.onAgentStart(false); // recovery run
  assert.equal(sent.length, 0);
  w.stop();
});

test("run that crosses into the peak window warns mid-run", async () => {
  const fetchImpl = fakeFetch(quotaPayload(0, 0));
  const { sent } = fakeSend();
  // Start 1ms before peak: Mon 05:59:59.999 UTC. Window opens at 06:00.
  let nowMs = Date.UTC(2026, 8, 28, 5, 59, 59, 999);
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: async (d, t) => {
      sent.push({ destHex: d, text: t });
    },
    apiKey: "key",
    fetchImpl,
    now: () => nowMs,
    pollIntervalMs: 10,
  });
  w.setEnabled(true);
  w.onAgentStart(true);
  assert.equal(sent.length, 0, "not yet in peak");
  // Advance the clock past the scheduled boundary and let timers fire.
  nowMs = Date.UTC(2026, 8, 28, 6, 5, 0);
  await sleep(30);
  assert.equal(sent.length, 1, "warned when window opened mid-run");
  assert.match(sent[0].text, /peak hours now/);
  w.stop();
});

test("readZaiKey returns null when auth file is missing", () => {
  // Point at a nonexistent dir.
  assert.equal(readZaiKey("/nonexistent-pi-lxmf-test-dir-xyz"), null);
});
