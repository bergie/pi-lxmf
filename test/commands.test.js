/**
 * Tests for chat-command parsing, model matching and formatters.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  formatModelList,
  formatSessionStats,
  formatStatus,
  matchModel,
  parseCommand,
} from "../src/commands.js";
import { chunkText, formatDuration, formatTokens } from "../src/text.js";

test("parseCommand recognises bridge syntax", () => {
  assert.deepEqual(parseCommand("/new"), { name: "new", args: "" });
  assert.deepEqual(parseCommand("/MODEL sonnet"), {
    name: "model",
    args: "sonnet",
  });
  assert.deepEqual(parseCommand("!abort now"), { name: "abort", args: "now" });
  assert.deepEqual(parseCommand("  /compact\nfocus on api  "), {
    name: "compact",
    args: "focus on api",
  });
  assert.deepEqual(parseCommand("!"), { name: "", args: "" });
});

test("parseCommand passes non-commands through as null", () => {
  assert.equal(parseCommand("hello world"), null);
  assert.equal(parseCommand("use /etc/hosts here"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand("/"), null);
});

test("matchModel prefers exact, then substring, then name", () => {
  const models = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    },
    { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  ];
  assert.equal(
    matchModel(models, "anthropic/claude-sonnet-4-5")?.id,
    "claude-sonnet-4-5",
  );
  assert.equal(matchModel(models, "CLAUDE-SONNET")?.id, "claude-sonnet-4-5");
  assert.equal(matchModel(models, "gemini")?.id, "gemini-2.5-pro");
  assert.equal(matchModel(models, "GPT")?.id, "gpt-5.2");
  assert.equal(matchModel(models, "nothing matches"), null);
  assert.equal(matchModel([], "x"), null);
  assert.equal(matchModel(models, ""), null);
});

test("formatModelList marks the current model", () => {
  const models = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  ];
  const text = formatModelList(models, { provider: "openai", id: "gpt-5.2" });
  assert.match(text, /anthropic\/claude-sonnet-4-5 — Claude Sonnet 4\.5$/m);
  assert.match(text, /openai\/gpt-5\.2.*← current/m);
});

test("formatStatus and formatSessionStats", () => {
  const status = formatStatus(
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinkingLevel: "high",
      isStreaming: false,
      sessionName: "fix-the-build",
      sessionFile: "/home/u/.pi/agent/sessions/abc.jsonl",
    },
    {
      identityHash: "a".repeat(32),
      deliveryHash: "b".repeat(32),
      owner: "c".repeat(32),
      uptimeMs: 3600_000,
    },
  );
  assert.match(status, /model: anthropic\/claude-sonnet-4-5/);
  assert.match(status, /session: fix-the-build · abc\.jsonl/);
  assert.match(status, /uptime: 1h/);

  const stats = formatSessionStats({
    userMessages: 3,
    assistantMessages: 3,
    toolCalls: 7,
    tokens: { total: 12345 },
    cost: 0.5,
    contextUsage: { percent: 31.4 },
    sessionId: "abc",
  });
  assert.match(stats, /3 in \/ 3 out \(7 tool calls\)/);
  assert.match(stats, /12,345 tokens/);
  assert.match(stats, /\$0\.50/);
  assert.match(stats, /context 31%/);
});

test("chunkText splits on boundaries and hard-cuts", () => {
  assert.deepEqual(chunkText("short", 100), ["short"]);
  assert.deepEqual(chunkText("", 100), []);
  assert.deepEqual(chunkText("   \n  ", 100), []);

  const paras = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n");
  const chunks = chunkText(paras, 65);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].length <= 65 && chunks[1].length <= 65);

  const hard = chunkText("x".repeat(100), 30);
  assert.deepEqual(
    hard.map((c) => c.length),
    [30, 30, 30, 10],
  );
});

test("chunkText throws on invalid maxChars", () => {
  assert.throws(() => chunkText("x", 0));
  assert.throws(() => chunkText("x", Number.NaN));
});

test("formatDuration and formatTokens", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(8000), "8s");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3600_000), "1h");
  assert.equal(formatDuration(9000_000 + 65_000), "2h 31m");
  assert.equal(formatDuration(3 * 86400_000 + 4 * 3600_000), "3d 4h");

  assert.equal(formatTokens({}), "no usage recorded");
  assert.equal(
    formatTokens({
      tokens: { total: 5 },
      cost: 0,
      contextUsage: { percent: 1.4 },
    }),
    "5 tokens, $0.00, context 1%",
  );
});
