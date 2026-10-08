/**
 * Tests for the Program Status Protocol (OSC 7501) parsing: the report
 * grammar validator and the chunk-stream sequence filter.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createStatusFilter,
  MAX_SEQUENCE_BYTES,
  parseStatusReport,
  statusSequence,
} from "../src/status.js";

/** base64("Login required") */
const B64_LOGIN = Buffer.from("Login required", "utf8").toString("base64");

test("parseStatusReport: full valid report", () => {
  const report = parseStatusReport(
    `state=blocked:kind=auth:app=pi:title=UGk=:msg=${B64_LOGIN}`,
  );
  assert.deepEqual(report, {
    state: "blocked",
    kind: "auth",
    app: "pi",
    title: "Pi",
    msg: "Login required",
  });
});

test("parseStatusReport: base64 padding optional", () => {
  // base64("hi") with padding stripped.
  const report = parseStatusReport("state=working:msg=aGk");
  assert.equal(report?.msg, "hi");
});

test("parseStatusReport: minimal report (state only)", () => {
  assert.deepEqual(parseStatusReport("state=idle"), { state: "idle" });
  assert.deepEqual(parseStatusReport("state=clear"), { state: "clear" });
});

test("parseStatusReport: missing or unknown state discards the report", () => {
  assert.equal(parseStatusReport(""), null);
  assert.equal(parseStatusReport("app=pi"), null);
  assert.equal(parseStatusReport("state=running"), null);
});

test("parseStatusReport: malformed pair skipped, rest processed", () => {
  // "nonsense" has no `=`; "=x" has an empty key; "UPPER=x" fails key grammar.
  const report = parseStatusReport(
    `nonsense:=x:UPPER=x:state=done:msg=${Buffer.from("ok").toString("base64")}`,
  );
  assert.deepEqual(report, { state: "done", msg: "ok" });
});

test("parseStatusReport: repeated key, last value wins", () => {
  const other = Buffer.from("other", "utf8").toString("base64");
  const report = parseStatusReport(
    `state=working:msg=${other}:msg=${Buffer.from("final").toString("base64")}`,
  );
  assert.equal(report?.msg, "final");
});

test("parseStatusReport: unknown keys ignored", () => {
  const report = parseStatusReport("state=idle:future=xyz");
  assert.deepEqual(report, { state: "idle" });
});

test("parseStatusReport: invalid kind/progress/app treated as absent", () => {
  const report = parseStatusReport(
    "state=blocked:kind=urgent:progress=101:app=bad name",
  );
  assert.deepEqual(report, { state: "blocked" });
  const report2 = parseStatusReport("state=working:progress=abc");
  assert.deepEqual(report2, { state: "working" });
});

test("parseStatusReport: valid kind and progress kept", () => {
  const report = parseStatusReport("state=working:progress=42");
  assert.deepEqual(report, { state: "working", progress: 42 });
  assert.deepEqual(parseStatusReport("state=blocked:kind=question"), {
    state: "blocked",
    kind: "question",
  });
});

test("parseStatusReport: whitespace around keys and values removed", () => {
  const report = parseStatusReport(
    `state = done : app = pi : msg = ${B64_LOGIN} `,
  );
  assert.deepEqual(report, { state: "done", app: "pi", msg: "Login required" });
});

test("parseStatusReport: control character in decoded msg discards whole report", () => {
  const bad = Buffer.from("line\nbreak", "utf8").toString("base64");
  assert.equal(parseStatusReport(`state=done:msg=${bad}`), null);
  const badTitle = Buffer.from("tab\there", "utf8").toString("base64");
  assert.equal(parseStatusReport(`state=done:title=${badTitle}`), null);
});

test("parseStatusReport: undecodable base64 discards the report", () => {
  // `.` is inside the value charset but outside the base64 alphabet.
  assert.equal(parseStatusReport("state=done:msg=ab.c"), null);
  // Length mod 4 == 1 is invalid base64.
  assert.equal(parseStatusReport("state=done:msg=abcde"), null);
  // Bytes outside the value charset skip the pair instead (rest applies).
  assert.deepEqual(parseStatusReport("state=done:msg=ab!c"), { state: "done" });
});

test("parseStatusReport: size limits discard the report", () => {
  const longMsg = Buffer.from("x".repeat(2049), "utf8").toString("base64");
  assert.equal(parseStatusReport(`state=done:msg=${longMsg}`), null);
  const longTitle = Buffer.from("y".repeat(193), "utf8").toString("base64");
  assert.equal(parseStatusReport(`state=done:title=${longTitle}`), null);
  const longKey = "k".repeat(17);
  assert.equal(parseStatusReport(`state=done:${longKey}=v`), null);
});

test("parseStatusReport: malformed id discards the report (no root fallback)", () => {
  // `,` is inside the value charset but not a legal segment character.
  assert.equal(parseStatusReport("state=done:id=bad,name"), null);
  assert.equal(parseStatusReport("state=done:id=build/"), null);
  assert.equal(parseStatusReport("state=done:id="), null);
  // Bytes outside the value charset skip the pair instead (no root write).
  assert.deepEqual(parseStatusReport("state=done:id=bad segment!"), {
    state: "done",
  });
  const nineDeep = Array.from({ length: 9 }, (_, i) => `s${i}`).join("/");
  assert.equal(parseStatusReport(`state=done:id=${nineDeep}`), null);
});

test("parseStatusReport: valid id kept", () => {
  assert.deepEqual(parseStatusReport("state=clear:id=build/test"), {
    state: "clear",
    id: "build/test",
  });
});

test("filter: plain JSONL passes through untouched", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  const line = '{"type":"agent_start"}\n{"type":"agent_settled"}\n';
  // Feed in awkward chunk splits.
  for (const part of [line.slice(0, 5), line.slice(5, 30), line.slice(30)]) {
    filter.push(part);
  }
  assert.equal(filter.flush(), "");
  assert.deepEqual(reports, []);
});

test("filter: extracts a sequence, passes the rest through", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  const before = '{"type":"response","id":"r1"}\n';
  const after = '{"success":true}\n';
  const out1 = filter.push(before + statusSequence("state=working:app=pi"));
  const out2 = filter.push(after);
  assert.equal(out1, before);
  assert.equal(out2, after);
  assert.deepEqual(reports, [{ state: "working", app: "pi" }]);
  assert.equal(filter.flush(), "");
});

test("filter: sequence split across many chunks, both terminators", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  const body = `state=blocked:kind=auth:msg=${B64_LOGIN}`;
  const withSt = statusSequence(body);
  const withBel = statusSequence(body, "bel");

  // Byte-by-byte feeding for the ST variant.
  let cleaned = "";
  for (const ch of `x${withSt}y`) cleaned += filter.push(ch);
  assert.equal(cleaned, "xy");
  assert.deepEqual(reports, [
    { state: "blocked", kind: "auth", msg: "Login required" },
  ]);

  // BEL terminator fed in two halves.
  reports.length = 0;
  cleaned = filter.push(withBel.slice(0, 10)) + filter.push(withBel.slice(10));
  assert.equal(cleaned, "");
  assert.equal(reports.length, 1);
});

test("filter: sequence glued onto a JSON line stays out of the JSONL stream", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  // pi can emit a report and an RPC record in the same chunk, in any order.
  const record = '{"type":"agent_start"}\n';
  const out =
    filter.push(statusSequence("state=done") + record) +
    filter.push(statusSequence("state=idle") + record);
  assert.equal(out, record + record);
  assert.deepEqual(
    reports.map((r) => r.state),
    ["done", "idle"],
  );
});

test("filter: unrelated escape sequences pass through", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  const windowTitle = "\x1b]0;my title\x1b\\";
  const out = filter.push(`a${windowTitle}b${statusSequence("state=idle")}`);
  assert.equal(out, `a${windowTitle}b`);
  assert.deepEqual(reports, [{ state: "idle" }]);
});

test("filter: ESC at chunk boundary does not swallow the next chunk", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  /** @type {string} */
  let out = filter.push("record\x1b");
  assert.equal(out, "record"); // ESC held back (could start a 7501 sequence)
  // The held ESC comes back at the front of the next cleaned chunk.
  out = filter.push("]0;title\x1b\\more");
  assert.equal(out, "\x1b]0;title\x1b\\more");
  assert.equal(filter.flush(), "");
  assert.deepEqual(reports, []);
});

test("filter: feature-detection query is swallowed, not reported", () => {
  /** @type {any[]} */
  const reports = [];
  /** @type {string[]} */
  const queries = [];
  const filter = createStatusFilter((r) => reports.push(r), {
    onQuery: (body) => queries.push(body),
  });
  const out = filter.push(`data${statusSequence("?")}tail`);
  assert.equal(out, "datatail");
  assert.deepEqual(reports, []);
  assert.deepEqual(queries, ["?"]);
});

test("filter: invalid report is dropped, stream continues", () => {
  /** @type {any[]} */
  const reports = [];
  /** @type {string[]} */
  const invalid = [];
  const filter = createStatusFilter((r) => reports.push(r), {
    onInvalid: (reason) => invalid.push(reason),
  });
  const out = filter.push(
    `${statusSequence("state=sideways")}${statusSequence("state=idle")}`,
  );
  assert.equal(out, "");
  assert.deepEqual(reports, [{ state: "idle" }]);
  assert.equal(invalid.length, 1);
});

test("filter: unterminated over-long sequence is discarded", () => {
  /** @type {any[]} */
  const reports = [];
  /** @type {string[]} */
  const invalid = [];
  const filter = createStatusFilter((r) => reports.push(r), {
    onInvalid: (reason) => invalid.push(reason),
  });
  const garbage = `\x1b]7501;state=working:msg=${"A".repeat(MAX_SEQUENCE_BYTES)}`;
  let out = "";
  // Feed in small chunks; the sequence never terminates.
  for (let i = 0; i < garbage.length; i += 64)
    out += filter.push(garbage.slice(i, i + 64));
  // Everything after the cap is dropped; no pass-through garbage appears.
  assert.equal(out, "");
  assert.deepEqual(reports, []);
  assert.equal(invalid.length, 1);
  // The filter recovers: a later valid sequence still comes through.
  out = filter.push(`${statusSequence("state=idle")}ok`);
  assert.equal(out, "ok");
  assert.deepEqual(reports, [{ state: "idle" }]);
});

test("filter: flush emits an unterminated tail as pass-through", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  assert.equal(filter.push("tail\x1b]7501;state=wor"), "tail");
  assert.equal(filter.flush(), "\x1b]7501;state=wor");
  assert.deepEqual(reports, []);
});

test("filter: multi-byte UTF-8 split across chunks survives", () => {
  /** @type {any[]} */
  const reports = [];
  const filter = createStatusFilter((r) => reports.push(r));
  const payload = Buffer.from('{"emoji":"😀😀"}\n', "utf8");
  // Split 3 bytes into the first emoji's 4-byte sequence.
  const out =
    filter.push(payload.subarray(0, 12)) + filter.push(payload.subarray(12));
  assert.equal(out, '{"emoji":"😀😀"}\n');
  assert.deepEqual(reports, []);
});
