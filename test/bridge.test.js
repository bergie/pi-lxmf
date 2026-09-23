/**
 * Bridge smoketests with a fake RPC client and a fake mesh: inbound
 * admission and pairing, prompts and steering, reply delivery,
 * empty-tail recovery, dialogs, commands, and session pointer handling.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Bridge } from "../src/bridge.js";

const OWNER = "aa11223344556677889900aabbccddeeff".slice(0, 32);
const STRANGER = "bb11223344556677889900aabbccddeeff".slice(0, 32);
const LINK = new Uint8Array([1, 2, 3, 4]);

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexBytes(hex) {
  return new Uint8Array(
    Array.from({ length: hex.length / 2 }, (_, i) =>
      Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    ),
  );
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {FakeMesh} mesh
 * @returns {string}
 */
function lastSent(mesh) {
  const last = mesh.sent.at(-1);
  assert.ok(last, "expected a sent message");
  return last.text;
}

class FakeRpc extends EventTarget {
  constructor() {
    super();
    /** @type {Array<{message: string, streamingBehavior?: string}>} */
    this.prompts = [];
    /** @type {any[]} */
    this.promptResponses = [];
    /** @type {any[]} */
    this.states = [];
    /** @type {Array<[string, ...any[]]>} */
    this.calls = [];
    this.sessionPath = null;
  }

  /**
   * @param {string} message
   * @param {"steer"|"followUp"} [streamingBehavior]
   */
  async prompt(message, streamingBehavior) {
    this.prompts.push({ message, streamingBehavior });
    this.calls.push(["prompt", message]);
    return this.promptResponses.length > 0
      ? this.promptResponses.shift()
      : { success: true };
  }

  async getState() {
    if (this.states.length > 0) return this.states.shift();
    return {
      isStreaming: false,
      sessionName: null,
      sessionFile: "/sessions/current.jsonl",
    };
  }

  async newSession() {
    this.calls.push(["new_session"]);
    return { cancelled: false };
  }

  async compact() {
    this.calls.push(["compact"]);
    return { tokensBefore: 100000, estimatedTokensAfter: 20000 };
  }

  /**
   * @param {string} provider
   * @param {string} modelId
   */
  async setModel(provider, modelId) {
    this.calls.push(["set_model", `${provider}/${modelId}`]);
    return { provider, id: modelId };
  }

  async getAvailableModels() {
    return [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
      { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
    ];
  }

  async getAvailableThinkingLevels() {
    return ["off", "low", "medium", "high"];
  }

  /**
   * @param {string} level
   */
  async setThinkingLevel(level) {
    this.calls.push(["set_thinking_level", level]);
  }

  async getSessionStats() {
    return { userMessages: 1, assistantMessages: 1, tokens: { total: 10 } };
  }

  /**
   * @param {string} name
   */
  async setSessionName(name) {
    this.calls.push(["set_session_name", name]);
  }

  async getCommands() {
    return [{ name: "skill:review", description: "Review code" }];
  }

  clearQueue() {
    this.calls.push(["clear_queue"]);
    return Promise.resolve({
      success: true,
      data: { steering: ["queued steer"], followUp: [] },
    });
  }

  abort() {
    this.calls.push(["abort"]);
  }

  /**
   * @param {string} id
   * @param {Record<string, any>} payload
   */
  respondUi(id, payload) {
    this.calls.push(["extension_ui_response", id, payload]);
  }

  /**
   * @param {string|null} path
   */
  setSessionPath(path) {
    this.sessionPath = path;
  }

  /** @param {any} event */
  emitEvent(event) {
    this.dispatchEvent(new CustomEvent("event", { detail: event }));
  }
}

class FakeMesh {
  constructor() {
    this.target = new EventTarget();
    /** @type {Array<{destinationHex: string, text: string, options: any}>} */
    this.sent = [];
    this.identityHash = "1".repeat(32);
    this.deliveryHash = "2".repeat(32);
  }

  get lxmf() {
    return this.target;
  }

  /**
   * @param {string} destinationHex
   * @param {string} text
   * @param {{link?: any, title?: string}} [options]
   */
  async sendText(destinationHex, text, options = {}) {
    this.sent.push({ destinationHex, text, options });
  }

  /**
   * @param {{sourceHash: string, content: string, title?: string, link?: any}} message
   */
  emitMessage(message) {
    this.target.dispatchEvent(
      new CustomEvent("message", {
        detail: {
          message: { ...message, sourceHash: hexBytes(message.sourceHash) },
          link: message.link,
        },
      }),
    );
  }
}

class FakeState {
  constructor() {
    /** @type {string|null} */
    this.owner = null;
    /** @type {string|null} */
    this.session = null;
  }

  loadOwner() {
    return this.owner;
  }

  /**
   * @param {string} hash
   */
  saveOwner(hash) {
    this.owner = hash;
  }

  loadSession() {
    return this.session ? { sessionFile: this.session } : null;
  }

  /**
   * @param {string} file
   */
  saveSession(file) {
    this.session = file;
  }
}

/**
 * @param {object} [options]
 * @param {any} [options.config]
 * @param {string|null} [options.owner]
 * @param {Function} [options.onShutdown]
 */
function makeBridge(options = {}) {
  const rpc = new FakeRpc();
  const mesh = new FakeMesh();
  const state = new FakeState();
  /** @type {string[]} */
  const shutdowns = [];
  const bridge = new Bridge({
    config: {
      midRunBehavior: "steer",
      chunkChars: 2500,
      name: "test-node",
      owner: options.owner ?? null,
      ...options.config,
    },
    rpc: /** @type {any} */ (rpc),
    mesh,
    state,
    log: { log: () => {}, error: () => {} },
    onShutdown: (reason) => shutdowns.push(reason),
  });
  bridge.start();
  bridge.setRpcReady(true);
  return { bridge, rpc, mesh, state, shutdowns };
}

test("inbound from owner becomes a prompt; reply delivered on settle", async () => {
  const { bridge, rpc, mesh, state } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: OWNER, content: "do the thing", link: LINK });
  await bridge.queue;

  assert.deepEqual(rpc.prompts, [
    { message: "do the thing", streamingBehavior: undefined },
  ]);
  // Session observations persist the pointer and update the resume path.
  assert.equal(state.session, "/sessions/current.jsonl");
  assert.equal(rpc.sessionPath, "/sessions/current.jsonl");

  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "did it" }] },
  });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);

  assert.equal(mesh.sent.length, 1);
  assert.equal(mesh.sent[0].text, "did it");
  assert.equal(mesh.sent[0].destinationHex, OWNER);
  assert.equal(mesh.sent[0].options.link, LINK);
  assert.equal(mesh.sent[0].options.title, "test-node");
});

test("mid-run prompts steer (authoritative isStreaming)", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  rpc.states.push({ isStreaming: true });
  mesh.emitMessage({ sourceHash: OWNER, content: "change of plans" });
  await bridge.queue;
  assert.deepEqual(rpc.prompts, [
    { message: "change of plans", streamingBehavior: "steer" },
  ]);
  assert.equal(mesh.sent.length, 0);
});

test("steer race: rejected idle prompt is retried queued", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  rpc.promptResponses.push({
    success: false,
    error: "Agent is streaming: specify streamingBehavior",
  });
  mesh.emitMessage({ sourceHash: OWNER, content: "while busy" });
  await bridge.queue;
  assert.deepEqual(rpc.prompts, [
    { message: "while busy", streamingBehavior: undefined },
    { message: "while busy", streamingBehavior: "steer" },
  ]);
});

test("non-owner messages are dropped silently", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: STRANGER, content: "let me in" });
  await bridge.queue;
  await sleep(10);
  assert.equal(rpc.prompts.length, 0);
  assert.equal(mesh.sent.length, 0);
});

test("first contact pairs the sender and still processes the message", async () => {
  const { bridge, rpc, mesh, state } = makeBridge();
  mesh.emitMessage({ sourceHash: STRANGER, content: "hello there" });
  await bridge.queue;
  await sleep(10);

  assert.equal(state.owner, STRANGER);
  assert.equal(mesh.sent.length, 1);
  assert.match(mesh.sent[0].text, /Paired: this Pi node is now driven by/);
  assert.equal(rpc.prompts.length, 1);

  // The paired owner can now drive; the previous owner hash is refused.
  mesh.emitMessage({ sourceHash: OWNER, content: "me too" });
  await bridge.queue;
  assert.equal(rpc.prompts.length, 1);
});

test("empty-tail recovery asks once, then nudges", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: OWNER, content: "hard task" });
  await bridge.queue;

  // Run settles with no assistant text at all.
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.equal(rpc.prompts.length, 2);
  assert.match(rpc.prompts[1].message, /LXMF/);
  assert.equal(mesh.sent.length, 0);

  // The recovery run also produces nothing: nudge, no loop.
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.equal(rpc.prompts.length, 2);
  assert.equal(mesh.sent.length, 1);
  assert.match(mesh.sent[0].text, /done \(no reply\)/);
});

test("recovery reply is delivered normally", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: OWNER, content: "task" });
  await bridge.queue;
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);

  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "here it is" }],
    },
  });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.deepEqual(
    mesh.sent.map((s) => s.text),
    ["here it is"],
  );
});

test("failed runs report the error instead of recovering", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: OWNER, content: "task" });
  await bridge.queue;
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({
    type: "auto_retry_end",
    success: false,
    finalError: "503 overloaded",
  });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.equal(rpc.prompts.length, 1);
  assert.equal(mesh.sent.length, 1);
  assert.match(mesh.sent[0].text, /run failed: 503 overloaded/);
});

test("every assistant text in an exchange is delivered", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: OWNER, content: "two-part answer please" });
  await bridge.queue;
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "checking…" }],
    },
  });
  rpc.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    },
  });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.deepEqual(
    mesh.sent.map((s) => s.text),
    ["checking…", "final answer"],
  );
});

test("extension dialogs are declined and reported", async () => {
  const { rpc, mesh } = makeBridge({ owner: OWNER });
  rpc.emitEvent({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Run dangerous command?",
  });
  rpc.emitEvent({
    type: "extension_ui_request",
    id: "ui-2",
    method: "notify",
    message: "just a note",
  });
  await sleep(10);
  const dismissal = rpc.calls.find((c) => c[0] === "extension_ui_response");
  assert.ok(dismissal);
  assert.equal(dismissal[1], "ui-1");
  assert.deepEqual(dismissal[2], { cancelled: true });
  assert.equal(mesh.sent.length, 1);
  assert.match(mesh.sent[0].text, /dialog dismissed: Run dangerous command\?/);
});

test("chat commands run without an LLM turn", async () => {
  const { bridge, rpc, mesh, shutdowns } = makeBridge({ owner: OWNER });

  mesh.emitMessage({ sourceHash: OWNER, content: "/new" });
  await bridge.queue;
  assert.ok(rpc.calls.some((c) => c[0] === "new_session"));
  assert.equal(rpc.prompts.length, 0);
  assert.match(lastSent(mesh), /New session started/);

  mesh.emitMessage({ sourceHash: OWNER, content: "!" });
  await bridge.queue;
  assert.ok(rpc.calls.some((c) => c[0] === "abort"));
  assert.equal(rpc.calls.filter((c) => c[0] === "clear_queue").length, 0);
  assert.match(lastSent(mesh), /aborted \(queue intact\)/);

  mesh.emitMessage({ sourceHash: OWNER, content: "/abort" });
  await bridge.queue;
  assert.ok(rpc.calls.some((c) => c[0] === "clear_queue"));
  assert.match(lastSent(mesh), /Aborted\. Dropped 1 queued message/);

  mesh.emitMessage({ sourceHash: OWNER, content: "/model gpt" });
  await bridge.queue;
  assert.ok(
    rpc.calls.some((c) => c[0] === "set_model" && c[1] === "openai/gpt-5.2"),
  );
  assert.match(lastSent(mesh), /Model set to openai\/gpt-5\.2/);

  mesh.emitMessage({ sourceHash: OWNER, content: "/think high" });
  await bridge.queue;
  assert.ok(
    rpc.calls.some((c) => c[0] === "set_thinking_level" && c[1] === "high"),
  );

  mesh.emitMessage({ sourceHash: OWNER, content: "/help" });
  await bridge.queue;
  assert.match(lastSent(mesh), /\/skill:review — Review code/);
  assert.match(lastSent(mesh), /! \(bare\) — quick interrupt/);

  mesh.emitMessage({ sourceHash: OWNER, content: "/quit" });
  await bridge.queue;
  await sleep(10);
  assert.match(lastSent(mesh), /Shutting down/);
  assert.equal(shutdowns.length, 1);
  assert.match(shutdowns[0], /quit/);
  assert.equal(rpc.prompts.length, 0);
});

test("unknown slash commands pass through as prompts", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  mesh.emitMessage({ sourceHash: OWNER, content: "/skill:review src/" });
  await bridge.queue;
  assert.deepEqual(rpc.prompts, [
    { message: "/skill:review src/", streamingBehavior: undefined },
  ]);
});

test("command failures are reported, not thrown", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  rpc.getState = async () => {
    throw new Error("state unavailable");
  };
  mesh.emitMessage({ sourceHash: OWNER, content: "/status" });
  await bridge.queue;
  assert.match(lastSent(mesh), /\/status failed: state unavailable/);
});

test("failed LXMF delivery is noted on the next message", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  let failNext = true;
  const realSend = mesh.sendText.bind(mesh);
  mesh.sendText = async (destinationHex, text, options) => {
    if (failNext) {
      failNext = false;
      throw new Error("no path");
    }
    return realSend(destinationHex, text, options);
  };

  mesh.emitMessage({ sourceHash: OWNER, content: "task one" });
  await bridge.queue;
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "reply one" }],
    },
  });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.equal(mesh.sent.length, 0); // delivery failed, noted

  // The next exchange delivers with the failure note prepended.
  mesh.emitMessage({ sourceHash: OWNER, content: "task two" });
  await bridge.queue;
  rpc.emitEvent({ type: "agent_start" });
  rpc.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "reply two" }],
    },
  });
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.equal(mesh.sent.length, 1);
  assert.match(mesh.sent[0].text, /could not be delivered/);
  assert.match(mesh.sent[0].text, /reply two/);
});

test("events arriving in the same chunk as the prompt response are not lost", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  // Simulate pi emitting the acceptance response and the entire run's
  // events inside one stdout chunk: handlePiEvent runs synchronously while
  // rpc.prompt() is still awaiting its (microtask-deferred) resolution.
  rpc.prompt = async (message, streamingBehavior) => {
    rpc.prompts.push({ message, streamingBehavior });
    rpc.emitEvent({ type: "agent_start" });
    rpc.emitEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "raced reply" }],
      },
    });
    rpc.emitEvent({ type: "agent_settled" });
    return { success: true };
  };
  mesh.emitMessage({ sourceHash: OWNER, content: "race me" });
  await bridge.queue;
  await sleep(10);
  assert.deepEqual(
    mesh.sent.map((s) => s.text),
    ["raced reply"],
  );
});

test("same-chunk empty run triggers recovery and delivers its reply", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  let n = 0;
  rpc.prompt = async (message, streamingBehavior) => {
    rpc.prompts.push({ message, streamingBehavior });
    n += 1;
    if (n === 1) {
      // First run: settles with no text at all, same chunk.
      rpc.emitEvent({ type: "agent_start" });
      rpc.emitEvent({ type: "agent_settled" });
    } else {
      // Recovery run: reply arrives in the same chunk as its response.
      rpc.emitEvent({ type: "agent_start" });
      rpc.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
        },
      });
      rpc.emitEvent({ type: "agent_settled" });
    }
    return { success: true };
  };
  mesh.emitMessage({ sourceHash: OWNER, content: "silent run" });
  await bridge.queue;
  await sleep(10);
  assert.equal(rpc.prompts.length, 2);
  assert.match(rpc.prompts[1].message, /LXMF/);
  assert.deepEqual(
    mesh.sent.map((s) => s.text),
    ["recovered"],
  );
});

test("prompt rejected after optimistic open closes the exchange", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  rpc.promptResponses.push({ success: false, error: "no such model" });
  mesh.emitMessage({ sourceHash: OWNER, content: "anything" });
  await bridge.queue;
  await sleep(10);
  assert.match(mesh.sent.at(-1)?.text ?? "", /prompt rejected: no such model/);
  assert.equal(bridge.exchangeActive, false);
  // A later unrelated settle must not trigger recovery for the dead exchange.
  rpc.emitEvent({ type: "agent_settled" });
  await sleep(10);
  assert.equal(rpc.prompts.length, 1);
  assert.equal(mesh.sent.length, 1);
});

test("messages arriving before readiness queue up", async () => {
  const { bridge, rpc, mesh } = makeBridge({ owner: OWNER });
  bridge.setRpcReady(false);
  mesh.emitMessage({ sourceHash: OWNER, content: "early bird" });
  await sleep(20);
  assert.equal(rpc.prompts.length, 0);
  bridge.setRpcReady(true);
  await bridge.queue;
  assert.equal(rpc.prompts.length, 1);
});
