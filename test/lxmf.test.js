/**
 * Smoketests for the outbound delivery machinery in src/lxmf.js: the
 * typed unknown-identity failure predicate, the send options passed to the
 * router (reticulum-js 0.9.3's `{ linkId, fallback, solicit, timeoutMs }`
 * escalation), and the propagation-node recovery in `createRetrySender`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fromHex, UnknownIdentityError } from "@reticulum/core";
import { LXMFConstants } from "@reticulum/lxmf";
import {
  contentFields,
  createRetrySender,
  isUnknownIdentityError,
} from "../src/lxmf.js";

const DEST = fromHex("ac880aeabfa2f2e70dc57a44aaf9f370");
const NODE = fromHex("f033f136cdae7691c9cfc35082540832");
const NODE_HEX = "f033f136cdae7691c9cfc35082540832";

/**
 * Fake `rns.transport`: the 0.9.3 solicitation entry point pi-lxmf calls
 * during propagation-node recovery. The real one path-requests the
 * destination and resolves on its announce (covered by reticulum-js's own
 * tests); here it is scripted per test.
 */
class FakeTransport {
  constructor() {
    /** @type {Array<[Uint8Array, number]>} */
    this.solicitCalls = [];
    /** @type {null|((dest: Uint8Array, timeoutMs: number) => Promise<object>)} */
    this.onSolicit = null;
  }

  /**
   * @param {Uint8Array} destinationHash
   * @param {number} [timeoutMs]
   */
  async recallOrSolicitIdentity(destinationHash, timeoutMs = 30_000) {
    this.solicitCalls.push([destinationHash, timeoutMs]);
    if (this.onSolicit) return this.onSolicit(destinationHash, timeoutMs);
    return {};
  }
}

/**
 * Fake `LXMRouter`: scripted `send` outcomes (each call shifts the next
 * `{throw}` or `{ok}`), on a FakeTransport for the recovery path.
 */
class FakeRouter {
  /**
   * @param {object} [options]
   * @param {Array<{throw?: Error, ok?: boolean}>} [options.sendOutcomes]
   */
  constructor({ sendOutcomes = [] } = {}) {
    this.rns = { transport: new FakeTransport() };
    /** @type {Array<any[]>} */
    this.sendCalls = [];
    this.sendOutcomes = sendOutcomes;
  }

  /** @param {...any} args */
  async send(...args) {
    this.sendCalls.push(args);
    const next = this.sendOutcomes.shift() ?? { ok: true };
    if (next.throw) throw next.throw;
  }
}

/**
 * @param {FakeRouter} lxmf
 * @param {string|null} [propagationNodeHex]
 * @returns {(message: any, link?: any) => Promise<void>}
 */
function sender(lxmf, propagationNodeHex = null) {
  return createRetrySender({
    lxmf: /** @type {any} */ (lxmf),
    identity: /** @type {any} */ ({}),
    propagationNodeHex,
    log: () => {},
    peerWaitMs: 500,
  }).sendWithRetry;
}

test("isUnknownIdentityError matches only the router's typed unknown-identity failure", () => {
  assert.ok(isUnknownIdentityError(new UnknownIdentityError(DEST)));
  assert.ok(!isUnknownIdentityError(new Error("some other failure")));
  assert.ok(!isUnknownIdentityError("UnknownIdentityError"));
});

test("sendWithRetry escalates to propagation only when a node is configured", async () => {
  const withoutNode = new FakeRouter();
  await sender(withoutNode)({ destinationHash: DEST });
  assert.deepEqual(withoutNode.sendCalls[0][2], {
    fallback: "opportunistic",
    timeoutMs: 500,
  });

  const withNode = new FakeRouter();
  await sender(withNode, NODE_HEX)({ destinationHash: DEST });
  assert.deepEqual(withNode.sendCalls[0][2], {
    fallback: "propagation",
    timeoutMs: 500,
  });
});

test("sendWithRetry passes the arrival link as linkId", async () => {
  const lxmf = new FakeRouter();
  const link = new Uint8Array(16);
  await sender(lxmf, NODE_HEX)({ destinationHash: DEST }, link);
  assert.deepEqual(lxmf.sendCalls[0][2], {
    fallback: "propagation",
    timeoutMs: 500,
    linkId: link,
  });
});

test("sendWithRetry keeps the router's failure without a propagation node", async () => {
  const failure = new UnknownIdentityError(DEST);
  const lxmf = new FakeRouter({ sendOutcomes: [{ throw: failure }] });
  await assert.rejects(sender(lxmf)({ destinationHash: DEST }), failure);
  assert.equal(lxmf.rns.transport.solicitCalls.length, 0);
});

test("sendWithRetry solicits the propagation node and resends on its announce", async () => {
  // The router escalated through direct and opportunistic delivery, handed
  // off to the propagation node — whose announce had not landed yet, so the
  // submit declined. The recovery solicits the node and resends.
  const lxmf = new FakeRouter({
    sendOutcomes: [
      {
        throw: new Error(
          `Propagation node identity unknown for ${NODE_HEX}; wait for its announce.`,
        ),
      },
    ],
  });
  await sender(lxmf, NODE_HEX)({ destinationHash: DEST });
  assert.equal(lxmf.sendCalls.length, 2); // failed attempt + resend
  assert.deepEqual(lxmf.rns.transport.solicitCalls, [[NODE, 500]]);
});

test("sendWithRetry gives up when the propagation node never announces", async () => {
  const submitDecline = new Error(
    `Propagation node identity unknown for ${NODE_HEX}; wait for its announce.`,
  );
  const lxmf = new FakeRouter({ sendOutcomes: [{ throw: submitDecline }] });
  lxmf.rns.transport.onSolicit = async () => {
    throw new UnknownIdentityError(NODE);
  };
  // The original failure stands — the node's silence is logged, not thrown.
  await assert.rejects(
    sender(lxmf, NODE_HEX)({ destinationHash: DEST }),
    submitDecline,
  );
  assert.equal(lxmf.sendCalls.length, 1); // no resend
});

test("contentFields signals Markdown rendering (FIELD_RENDERER)", () => {
  const fields = contentFields();
  assert.equal(fields.size, 1);
  assert.equal(
    fields.get(LXMFConstants.FIELD_RENDERER),
    LXMFConstants.RENDERER_MARKDOWN,
  );
  // Wire values per upstream LXMF: field 0x0F, renderer 0x02.
  assert.equal(LXMFConstants.FIELD_RENDERER, 0x0f);
  assert.equal(LXMFConstants.RENDERER_MARKDOWN, 0x02);
});
