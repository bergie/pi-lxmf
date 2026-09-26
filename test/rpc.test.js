/**
 * Tests for the RPC JSONL framing and the `PiRpcClient` command/response
 * correlation, using an injectable fake child process.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  assistantText,
  createJsonlReader,
  PiRpcClient,
  RpcError,
} from "../src/rpc.js";

test("jsonl reader: splits on LF only, tolerates CR and U+2028 in strings", () => {
  /** @type {string[]} */
  const lines = [];
  const reader = createJsonlReader((line) => lines.push(line));

  // A record containing U+2028 (which node:readline would split on).
  const tricky = JSON.stringify({ text: "line separated" });
  reader.push(Buffer.from(`${tricky}\r\n`));
  reader.push(`{"a":1}\n`);
  assert.deepEqual(lines, [tricky, '{"a":1}']);
  assert.equal(lines.length, 2);
});

test("jsonl reader: multi-byte UTF-8 straddling chunks", () => {
  /** @type {string[]} */
  const lines = [];
  const reader = createJsonlReader((line) => lines.push(line));
  const payload = Buffer.from('{"emoji":"😀😀"}\n', "utf8");
  // Split mid-codepoint (3 bytes into the first emoji's 4 bytes).
  reader.push(payload.subarray(0, 13));
  reader.push(payload.subarray(13));
  assert.deepEqual(lines, ['{"emoji":"😀😀"}']);
});

test("jsonl reader: multiple records in one chunk and tail flush", () => {
  /** @type {string[]} */
  const lines = [];
  const reader = createJsonlReader((line) => lines.push(line));
  reader.push("one\ntwo\nthree");
  reader.flush();
  assert.deepEqual(lines, ["one", "two", "three"]);
});

test("jsonl reader: empty lines and lone CR are ignored", () => {
  /** @type {string[]} */
  const lines = [];
  const reader = createJsonlReader((line) => lines.push(line));
  reader.push("\n\r\n\n");
  assert.deepEqual(lines, []);
});

test("assistantText extracts text blocks", () => {
  assert.equal(
    assistantText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hello" },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
        { type: "text", text: "world" },
      ],
    }),
    "hello\n\nworld",
  );
  assert.equal(assistantText({ role: "assistant", content: "plain" }), "plain");
  assert.equal(
    assistantText({
      role: "assistant",
      content: [{ type: "toolCall", id: "1" }],
    }),
    "",
  );
});

/**
 * A fake child process driven by the tests.
 */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    /** @type {string[]} */
    this.written = [];
    /** @type {Array<() => void>} */
    this.waiters = [];
    this.stdin.on("data", (/** @type {Buffer} */ chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.written.push(line);
      }
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
  }

  /**
   * Resolves once at least one command has been written.
   *
   * @returns {Promise<void>}
   */
  whenCommand() {
    if (this.written.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Replies to the last written command with a response. Waits until a
   * command exists (readiness probes fire on a delay).
   *
   * @param {object} [response]
   */
  async reply(response = { success: true, data: {} }) {
    await this.whenCommand();
    const last = this.written[this.written.length - 1];
    const cmd = JSON.parse(last);
    this.stdout.write(
      `${JSON.stringify({ type: "response", id: cmd.id, ...response })}\n`,
    );
  }

  /**
   * Emits an RPC event.
   *
   * @param {object} event
   */
  emitEvent(event) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  kill() {}
}

/**
 * @param {object} [options] - PiRpcClient options.
 * @returns {{client: PiRpcClient, child: FakeChild}}
 */
function makeClient(options = {}) {
  const child = new FakeChild();
  const client = new PiRpcClient({
    cwd: "/tmp",
    spawnFn: () => child,
    log: () => {},
    ...options,
  });
  return { client, child };
}

test("request/response correlation and argv", async () => {
  const { client, child } = makeClient({ model: "anthropic/x" });
  /** @type {any[]} */
  const events = [];
  client.addEventListener("event", (/** @type {any} */ e) =>
    events.push(e.detail),
  );

  const started = client.start();
  // Answer the readiness probe.
  setTimeout(() => child.reply(), 10);
  await started;

  const pending = client.request({ type: "get_state" });
  child.reply({ success: true, data: { isStreaming: false } });
  const response = await pending;
  assert.equal(response.data.isStreaming, false);

  child.emitEvent({ type: "agent_start" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    events.map((e) => e.type),
    ["agent_start"],
  );

  // Unparseable lines are dropped without breaking the stream.
  child.stdout.write("not json\n");
  child.emitEvent({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    events.map((e) => e.type),
    ["agent_start", "agent_settled"],
  );

  client.stop();
});

test("request timeout rejects", async () => {
  const { client, child } = makeClient();
  const started = client.start();
  setTimeout(() => child.reply(), 10);
  await started;
  await assert.rejects(client.request({ type: "compact" }, 50), RpcError);
  client.stop();
});

test("prompt writes streamingBehavior only when given", async () => {
  const { client, child } = makeClient();
  const started = client.start();
  setTimeout(() => child.reply(), 10);
  await started;

  const pending = client.prompt("hello world");
  child.reply();
  await pending;
  assert.deepEqual(JSON.parse(/** @type {string} */ (child.written.at(-1))), {
    type: "prompt",
    message: "hello world",
    id: "r2",
  });

  const pendingSteer = client.prompt("steer me", "steer");
  child.reply();
  await pendingSteer;
  assert.deepEqual(JSON.parse(/** @type {string} */ (child.written.at(-1))), {
    type: "prompt",
    message: "steer me",
    streamingBehavior: "steer",
    id: "r3",
  });
  client.stop();
});

test("failed commands throw via dataOf", async () => {
  const { client, child } = makeClient();
  const started = client.start();
  setTimeout(() => child.reply(), 10);
  await started;

  const pending = client.getState();
  child.reply({ success: false, error: "boom" });
  await assert.rejects(pending, /boom/);
  client.stop();
});

test("unexpected exit schedules a restart and re-probes", async () => {
  const { client, child } = makeClient({ restartBaseDelayMs: 5 });
  /** @type {string[]} */
  const lifecycle = [];
  client.addEventListener("restarting", () => lifecycle.push("restarting"));
  client.addEventListener("ready", () => lifecycle.push("ready"));

  const started = client.start();
  setTimeout(() => child.reply(), 10);
  await started;
  assert.deepEqual(lifecycle, ["ready"]);

  // Unexpected exit: PiRpcClient spawns a new fake child via spawnFn.
  const nextChild = new FakeChild();
  const spawnCalls = [];
  client.spawnFn = () => {
    spawnCalls.push(1);
    return nextChild;
  };
  child.emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(lifecycle, ["ready", "restarting"]);

  // The respawn probe fires ~300 ms after spawn; answer it and expect ready.
  await new Promise((r) => setTimeout(r, 400));
  nextChild.reply();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lifecycle, ["ready", "restarting", "ready"]);
  client.stop();
});

test("crash loop gives up and emits dead", async () => {
  const { client, child } = makeClient({ restartBaseDelayMs: 5 });
  /** @type {any[]} */
  const dead = [];
  client.addEventListener("dead", (/** @type {any} */ e) =>
    dead.push(e.detail),
  );
  const started = client.start();
  setTimeout(() => child.reply(), 10);
  await started;

  let current = child;
  for (let i = 0; i < 4; i++) {
    current.emit("exit", 1, null);
    // Backoff 5/10/20 ms: wait for the respawn, then exit the new child.
    await new Promise((r) => setTimeout(r, 60));
    current = /** @type {any} */ (client.child) ?? current;
  }
  assert.equal(dead.length, 1);
  assert.match(dead[0].reason, /crashed/);
  client.stop();
});

test("start fails when pi never becomes ready", async () => {
  const child = new FakeChild();
  const client = new PiRpcClient({
    cwd: "/tmp",
    spawnFn: () => child,
    log: () => {},
  });
  await assert.rejects(client.start({ readyTimeoutMs: 300 }), RpcError);
  client.stop();
});

test("setCwd respawns the child in the new cwd, carrying model and session", async () => {
  /** @type {{child: FakeChild, options: any}[]} */
  const spawns = [];
  let current = new FakeChild();
  const client = new PiRpcClient({
    model: "anthropic/x",
    cwd: "/old",
    sessionPath: "/sessions/old.jsonl",
    spawnFn: (
      /** @type {string} */ _bin,
      /** @type {string[]} */ _argv,
      /** @type {any} */ options,
    ) => {
      spawns.push({ child: current, options });
      return current;
    },
    log: () => {},
  });
  const started = client.start();
  setTimeout(() => current.reply(), 10);
  await started;
  assert.equal(spawns[0].options.cwd, "/old");

  /** @type {any[]} */
  const switching = [];
  client.addEventListener("switching", (/** @type {any} */ e) =>
    switching.push(e.detail),
  );
  /** @type {any[]} */
  const restarting = [];
  client.addEventListener("restarting", () => restarting.push(1));

  const old = current;
  const switched = client.setCwd("/new");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(switching, [{ cwd: "/new" }]);
  assert.equal(client.cwd, "/new");

  // The killed child's exit is the expected trigger: immediate respawn,
  // no crash-restart event, no crash-loop counting.
  current = new FakeChild();
  old.emit("exit", null, "SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].options.cwd, "/new");
  assert.deepEqual(restarting, []);
  assert.deepEqual(client.restartTimestamps, []);
  assert.ok(client.argv().includes("anthropic/x"));
  assert.equal(client.sessionPath, "/sessions/old.jsonl");

  // The respawn probe fires ~300 ms after spawn; answer it.
  const probing = current;
  setTimeout(() => probing.reply(), 350);
  await switched;
  assert.equal(client.ready, true);
  client.stop();
});

test("setCwd to the same cwd is a no-op", async () => {
  const child = new FakeChild();
  /** @type {any[]} */
  const spawns = [];
  const client = new PiRpcClient({
    cwd: "/old",
    spawnFn: (
      /** @type {string} */ bin,
      /** @type {string[]} */ argv,
      /** @type {any} */ options,
    ) => {
      spawns.push({ bin, argv, options });
      return child;
    },
    log: () => {},
  });
  const started = client.start();
  setTimeout(() => child.reply(), 10);
  await started;
  await client.setCwd("/old");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spawns.length, 1);
  client.stop();
});

test("setCwd rejects when the replacement never becomes ready", async () => {
  const child = new FakeChild();
  let current = child;
  const client = new PiRpcClient({
    cwd: "/old",
    spawnFn: () => current,
    log: () => {},
  });
  const started = client.start();
  setTimeout(() => current.reply(), 10);
  await started;

  const old = current;
  const switched = client.setCwd("/new", { readyTimeoutMs: 200 });
  current = new FakeChild();
  old.emit("exit", null, "SIGTERM");
  await assert.rejects(switched, /not ready in \/new/);
  client.stop();
});
