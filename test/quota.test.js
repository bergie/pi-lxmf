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

/**
 * Builds a fetch impl backed by a mutable live quota state, so tests can
 * flip buckets between polls.
 *
 * @param {{fiveHourPct: number, weeklyPct: number, fiveHourReset?: number, weeklyReset?: number}} live
 * @returns {any}
 */
function liveFetch(live) {
  /** @param {string} _url @param {{headers?: any}} [opts] */
  const fn = async (_url, opts) => {
    fn.calls.push({ auth: opts?.headers?.Authorization });
    return {
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              percentage: live.fiveHourPct,
              nextResetTime: live.fiveHourReset ?? 0,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              percentage: live.weeklyPct,
              nextResetTime: live.weeklyReset ?? 0,
            },
          ],
          level: "pro",
        },
      }),
    };
  };
  /** @type {Array<{auth: string}>} */
  fn.calls = [];
  return fn;
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

/**
 * Watcher factory with sensible test defaults.
 *
 * @param {object} options - `GlmQuotaWatcher` constructor options; only
 *   `ownerDestinationHash` and `sendText` are defaulted here.
 * @param {{send: any, sent: any[]}} [sink] - Fake send sink (optional).
 * @returns {{w: any, sent: any[]}}
 */
function makeWatcher(options = {}, sink) {
  const fake = sink ?? fakeSend();
  const w = new GlmQuotaWatcher({
    ownerDestinationHash: OWNER_DEST,
    sendText: fake.send,
    apiKey: "key",
    pollIntervalMs: 10,
    ...options,
  });
  return { w, sent: fake.sent };
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
  const { w, sent } = makeWatcher({
    apiKey: null,
    fetchImpl: liveFetch({ fiveHourPct: 100, weeklyPct: 10 }),
  });
  // Everything is a no-op when disabled by missing key.
  w.setEnabled(true);
  w.onError("403 quota exceeded");
  w.onAgentStart(true);
  assert.equal(w.pollTimer, null);
  assert.equal(sent.length, 0);
});

test("non-zai model: nothing fires", async () => {
  const fetchImpl = liveFetch({ fiveHourPct: 100, weeklyPct: 10 });
  const { w, sent } = makeWatcher({
    fetchImpl,
    now: () => Date.UTC(2026, 8, 28, 7, 0, 0), // peak time
  });
  // Never enabled (active model is cortecs): errors and agent_start do nothing.
  w.onError("403 quota exhausted");
  w.onAgentStart(true);
  await sleep(20);
  assert.equal(sent.length, 0);
  assert.equal(w.pollTimer, null);
  w.stop();
});

test("enabling on an exhausted bucket notifies immediately (startup case)", async () => {
  const fetchImpl = liveFetch({ fiveHourPct: 100, weeklyPct: 62 });
  const fetchCalls = fetchImpl;
  const nowMs = Date.UTC(2026, 8, 28, 12, 0, 0); // non-peak
  const { w, sent } = makeWatcher({
    fetchImpl,
    now: () => nowMs,
  });
  // Daemon start with the active model already GLM: setEnabled(true) is
  // the first gate flip; the first sample runs immediately.
  w.setEnabled(true);
  await sleep(10);
  assert.ok(fetchCalls.calls.length >= 1, "immediate startup sample");
  assert.equal(sent.length, 1, "exhaustion notice delivered at startup");
  assert.match(sent[0].text, /5h quota exhausted/);
  assert.equal(sent[0].destHex, OWNER_DEST);
  assert.ok(w.pollTimer, "continuous sampler running while enabled");
  // No duplicate notice from subsequent samples.
  await sleep(25);
  assert.equal(sent.length, 1, "exhaustion notice is once per episode");
  w.stop();
});

test("quota error on a GLM model arms the sampler; recovery delivers one message", async () => {
  const live = { fiveHourPct: 100, weeklyPct: 62 };
  const fetchImpl = liveFetch(live);
  const t0 = Date.UTC(2026, 8, 28, 12, 0, 0); // non-peak
  let nowMs = t0;
  const { w, sent } = makeWatcher({
    fetchImpl,
    now: () => nowMs,
  });
  w.setEnabled(true); // active model is GLM
  await sleep(10);
  // The startup sample already notified exhaustion; clear it.
  sent.length = 0;
  w.onError("403 quota exceeded");
  await sleep(10);
  assert.equal(w.wasExhausted, true);
  assert.ok(w.pollTimer, "sampler running");
  // The error-triggered sample must not duplicate the exhaustion notice.
  assert.equal(sent.length, 0, "no duplicate exhaustion notice");

  // Recover: advance time + flip the bucket.
  nowMs += 90 * 60_000; // 90 min later
  live.fiveHourPct = 20;
  await sleep(20);
  const recoveries = sent.filter((s) => /available again/.test(s.text));
  assert.equal(recoveries.length, 1, "exactly one recovery notification");
  assert.match(recoveries[0].text, /5h quota available again/);
  assert.match(recoveries[0].text, /Weekly: 62%/);
  assert.match(recoveries[0].text, /1h 30m/);
  assert.equal(w.wasExhausted, false);
  w.stop();
});

test("crossing 90% warns once per window (5h and weekly)", async () => {
  const live = { fiveHourPct: 89, weeklyPct: 91 };
  const fetchImpl = liveFetch(live);
  const now = () => Date.UTC(2026, 8, 28, 12, 0, 0);
  const { w, sent } = makeWatcher({ fetchImpl, now });
  w.setEnabled(true);
  await sleep(10);
  // First sample: 5h at 89% (no warning), weekly at 91% (warn).
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /weekly quota at 91%/);
  assert.doesNotMatch(sent[0].text, /5h quota at/);

  // 5h crosses the threshold on a later sample: one warning, no repeat.
  live.fiveHourPct = 92;
  await sleep(25);
  const warns = sent.filter((s) => /5h quota at 92%/.test(s.text));
  assert.equal(warns.length, 1);
  const total5hWarns = sent.filter((s) => /5h quota at/.test(s.text)).length;
  assert.equal(total5hWarns, 1, "no repeated 5h warning in the same window");
  const totalWeeklyWarns = sent.filter((s) =>
    /weekly quota at/.test(s.text),
  ).length;
  assert.equal(totalWeeklyWarns, 1, "no repeated weekly warning");
  w.stop();
});

test("exhaustion suppresses the 90% warning until the window resets", async () => {
  const live = { fiveHourPct: 100, weeklyPct: 10 };
  const fetchImpl = liveFetch(live);
  const now = () => Date.UTC(2026, 8, 28, 12, 0, 0);
  const { w, sent } = makeWatcher({ fetchImpl, now });
  w.setEnabled(true);
  await sleep(10);
  assert.match(sent[0].text, /exhausted/);
  // Recovery lands at 95%: above the threshold, but the window's warning
  // was consumed by the episode — no "at 95%" line.
  live.fiveHourPct = 95;
  await sleep(25);
  const recovered = sent.find((s) => /available again/.test(s.text));
  assert.ok(recovered, "recovery notice delivered");
  assert.equal(
    sent.filter((s) => /5h quota at/.test(s.text)).length,
    0,
    "no 90% warning in the episode's window",
  );
  w.stop();
});

test("a second error while the sampler is running does not start a second poller or re-notify", async () => {
  const live = { fiveHourPct: 100, weeklyPct: 10 };
  const fetchImpl = liveFetch(live);
  const now = () => Date.UTC(2026, 8, 28, 12, 0, 0);
  const { w, sent } = makeWatcher({ fetchImpl, now });
  w.setEnabled(true);
  await sleep(10);
  sent.length = 0; // drop the startup exhaustion notice
  const firstTimer = w.pollTimer;
  assert.ok(firstTimer);
  w.onError("429 usage limit reached");
  await sleep(10);
  assert.equal(w.pollTimer, firstTimer, "no second poller");
  assert.equal(sent.length, 0, "no duplicate notification while exhausted");
  w.stop();
});

test("notices are deferred to agent_settled while an owner-triggered run is live", async () => {
  const live = { fiveHourPct: 40, weeklyPct: 10 };
  const fetchImpl = liveFetch(live);
  const now = () => Date.UTC(2026, 8, 28, 12, 0, 0);
  const { w, sent } = makeWatcher({ fetchImpl, now });
  w.setEnabled(true);
  await sleep(10);
  assert.equal(sent.length, 0, "nothing to warn about yet");

  // Run starts; quota exhausts mid-run.
  w.onAgentStart(true);
  live.fiveHourPct = 100;
  await sleep(25);
  assert.equal(sent.length, 0, "exhaustion notice held while the run is live");
  // The run settles: the queued notice goes out.
  w.onAgentSettled();
  await sleep(10);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /exhausted/);
  w.stop();
});

test("start-of-run peak warning fires once per run during peak hours", async () => {
  const fetchImpl = liveFetch({ fiveHourPct: 0, weeklyPct: 0 });
  const now = () => Date.UTC(2026, 8, 28, 7, 0, 0); // Mon 07:00 UTC = peak
  const { w, sent } = makeWatcher({ fetchImpl, now });
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
  const fetchImpl = liveFetch({ fiveHourPct: 0, weeklyPct: 0 });
  const now = () => Date.UTC(2026, 8, 28, 7, 0, 0);
  const { w, sent } = makeWatcher({ fetchImpl, now });
  w.setEnabled(true);
  w.onAgentStart(false); // recovery run
  assert.equal(sent.length, 0);
  w.stop();
});

test("run that crosses into the peak window warns mid-run", async () => {
  const fetchImpl = liveFetch({ fiveHourPct: 0, weeklyPct: 0 });
  // Start 1ms before peak: Mon 05:59:59.999 UTC. Window opens at 06:00.
  let nowMs = Date.UTC(2026, 8, 28, 5, 59, 59, 999);
  const { w, sent } = makeWatcher({ fetchImpl, now: () => nowMs });
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

test("disabling (model switch) stops the sampler and flushes queued notices", async () => {
  const live = { fiveHourPct: 40, weeklyPct: 10 };
  const fetchImpl = liveFetch(live);
  const now = () => Date.UTC(2026, 8, 28, 12, 0, 0);
  const { w, sent } = makeWatcher({ fetchImpl, now });
  w.setEnabled(true);
  await sleep(10);
  assert.equal(sent.length, 0, "nothing to warn about yet");
  // Owner-triggered run goes live; quota exhausts mid-run.
  w.onAgentStart(true);
  live.fiveHourPct = 100;
  await sleep(25);
  assert.equal(sent.length, 0, "notice queued, not yet flushed");
  // The owner switches models mid-run: the gate flip must not lose it.
  w.setEnabled(false);
  assert.equal(w.pollTimer, null, "sampler stopped");
  assert.equal(sent.length, 1, "queued notice flushed on disable");
  assert.match(sent[0].text, /exhausted/);
});

test("readZaiKey returns null when auth file is missing", () => {
  // Point at a nonexistent dir.
  assert.equal(readZaiKey("/nonexistent-pi-lxmf-test-dir-xyz"), null);
});
