/**
 * Smoketests for the outbound delivery machinery in src/lxmf.js: the
 * unknown-identity failure predicate, the path-request/announce wait, and
 * the full `createRetrySender` escalation chain (direct → identity wait →
 * link retry → no-link retry → propagation-node store-and-forward).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fromHex } from "@reticulum/core";

import {
  createRetrySender,
  isUnknownIdentityError,
  waitForPeerIdentity,
} from "../src/lxmf.js";

const DEST = fromHex("ac880aeabfa2f2e70dc57a44aaf9f370");
const OTHER = fromHex("f033f136cdae7691c9cfc35082540832");

/**
 * Fake `rns.transport`: an EventTarget whose `recallIdentity` answers only
 * after an announce for that destination has been dispatched (mirrors the
 * real transport, which remembers the identity before dispatching the
 * event). `requestPath` records the call and optionally schedules the
 * announce that a real peer (or a node holding its path) would send.
 */
class FakeTransport extends EventTarget {
  constructor() {
    super();
    /** @type {string[]} */
    this.pathRequests = [];
    /** @type {Map<string, object>} */
    this.identities = new Map();
  }

  /**
   * @param {Uint8Array} destinationHash
   */
  async requestPath(destinationHash) {
    this.pathRequests.push(Buffer.from(destinationHash).toString("hex"));
  }

  /**
   * @param {Uint8Array} destinationHash
   */
  announce(destinationHash) {
    this.identities.set(Buffer.from(destinationHash).toString("hex"), {});
    this.dispatchEvent(
      new CustomEvent("announce", { detail: { destinationHash } }),
    );
  }

  /**
   * @param {Uint8Array} destinationHash
   */
  async recallIdentity(destinationHash) {
    return (
      this.identities.get(Buffer.from(destinationHash).toString("hex")) ?? null
    );
  }
}

test("isUnknownIdentityError matches only the router's unknown-identity failure", () => {
  assert.ok(
    isUnknownIdentityError(
      new Error(
        "Cannot deliver: identity for ac880aeabfa2f2e70dc57a44aaf9f370 is unknown",
      ),
    ),
  );
  assert.ok(!isUnknownIdentityError(new Error("some other failure")));
  assert.ok(!isUnknownIdentityError("Cannot deliver: identity for …"));
});

test("waitForPeerIdentity resolves immediately when the identity is already known", async () => {
  const transport = new FakeTransport();
  transport.identities.set(Buffer.from(DEST).toString("hex"), {});
  assert.equal(await waitForPeerIdentity(transport, DEST, 1000), true);
  assert.equal(transport.pathRequests.length, 0);
});

test("waitForPeerIdentity solicits the peer and resolves on its announce", async () => {
  const transport = new FakeTransport();
  const promise = waitForPeerIdentity(transport, DEST, 2000);
  // The solicited peer answers with its announce.
  setTimeout(() => transport.announce(DEST), 5);
  assert.equal(await promise, true);
  assert.deepEqual(transport.pathRequests, [
    "ac880aeabfa2f2e70dc57a44aaf9f370",
  ]);
});

test("waitForPeerIdentity ignores announces for other destinations", async () => {
  const transport = new FakeTransport();
  const promise = waitForPeerIdentity(transport, DEST, 100);
  // A different peer announces mid-wait: must not resolve the wait.
  setTimeout(() => transport.announce(OTHER), 5);
  assert.equal(await promise, false);
  assert.deepEqual(transport.pathRequests, [
    "ac880aeabfa2f2e70dc57a44aaf9f370",
  ]);
});

test("waitForPeerIdentity gives up after the timeout", async () => {
  const transport = new FakeTransport();
  // requestPath that never gets answered (peer offline).
  transport.requestPath = async (destinationHash) => {
    transport.pathRequests.push(Buffer.from(destinationHash).toString("hex"));
  };
  assert.equal(await waitForPeerIdentity(transport, DEST, 50), false);
});

/**
 * Fake `LXMRouter`: scripted `send`/`submitToPropagationNode` outcomes
 * (each call shifts the next `{throw}` or `{ok}`), on a FakeTransport so
 * the announce-wait paths behave like the real mesh stack.
 */
class FakeRouter {
  /**
   * @param {object} [options]
   * @param {Array<{throw?: Error, ok?: boolean}>} [options.sendOutcomes]
   * @param {Array<{throw?: Error, ok?: boolean}>} [options.submitOutcomes]
   */
  constructor({ sendOutcomes = [], submitOutcomes = [] } = {}) {
    this.rns = { transport: new FakeTransport() };
    /** @type {Array<any[]>} */
    this.sendCalls = [];
    /** @type {Array<any[]>} */
    this.submitCalls = [];
    this.sendOutcomes = sendOutcomes;
    this.submitOutcomes = submitOutcomes;
  }

  /**
   * @param {Array<{throw?: Error, ok?: boolean}>} outcomes
   * @param {any[]} call
   */
  static async outcome(outcomes, call) {
    const next = outcomes.shift() ?? { ok: true };
    if (next.throw) throw next.throw;
    return call;
  }

  /** @param {...any} args */
  async send(...args) {
    this.sendCalls.push(args);
    return FakeRouter.outcome(this.sendOutcomes, args);
  }

  /** @param {...any} args */
  async submitToPropagationNode(...args) {
    this.submitCalls.push(args);
    return FakeRouter.outcome(this.submitOutcomes, args);
  }
}

const UNKNOWN_DEST = () =>
  new Error(
    `Cannot deliver: identity for ac880aeabfa2f2e70dc57a44aaf9f370 is unknown`,
  );
const NO_PROOF = () =>
  new Error(
    "Opportunistic delivery to ac880aeabfa2f2e70dc57a44aaf9f370 failed: no delivery proof was received from the recipient",
  );

/**
 * @param {FakeRouter} lxmf
 * @param {string|null} propagationNodeHex
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

test("sendWithRetry recovers when the announce lands mid-wait (restart race)", async () => {
  const lxmf = new FakeRouter({ sendOutcomes: [{ throw: UNKNOWN_DEST() }] });
  const transport = lxmf.rns.transport;
  const message = { destinationHash: DEST };
  const done = sender(lxmf)(message);
  // The solicited owner answers with its announce during the wait.
  setTimeout(() => transport.announce(DEST), 5);
  await done;
  assert.equal(lxmf.sendCalls.length, 2); // failed attempt + retry
  assert.equal(lxmf.submitCalls.length, 0); // never reached propagation
  assert.deepEqual(transport.pathRequests, [
    "ac880aeabfa2f2e70dc57a44aaf9f370",
  ]);
});

test("sendWithRetry escalates to the propagation node when direct fails", async () => {
  const lxmf = new FakeRouter({
    sendOutcomes: [
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
    ],
  });
  const message = { destinationHash: DEST };
  await sender(lxmf, "f033f136cdae7691c9cfc35082540832")(message);
  assert.equal(lxmf.sendCalls.length, 3); // initial + link retry + no-link
  assert.equal(lxmf.submitCalls.length, 1);
  assert.equal(lxmf.submitCalls[0][0], message); // same LXMessage object
});

test("sendWithRetry without a propagation node keeps the failure", async () => {
  const lxmf = new FakeRouter({
    sendOutcomes: [
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
    ],
  });
  await assert.rejects(sender(lxmf)({ destinationHash: DEST }), NO_PROOF());
  assert.equal(lxmf.submitCalls.length, 0);
});

test("sendWithRetry waits for the propagation node's announce, then submits", async () => {
  const lxmf = new FakeRouter({
    sendOutcomes: [
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
    ],
    submitOutcomes: [
      {
        throw: new Error(
          "Propagation node identity unknown for f033f136cdae7691c9cfc35082540832; wait for its announce.",
        ),
      },
    ],
  });
  const transport = lxmf.rns.transport;
  const done = sender(
    lxmf,
    "f033f136cdae7691c9cfc35082540832",
  )({
    destinationHash: DEST,
  });
  setTimeout(() => transport.announce(OTHER), 5); // node announces mid-wait
  await done;
  assert.equal(lxmf.submitCalls.length, 2); // failed submit + retry after announce
  assert.deepEqual(transport.pathRequests, [
    "f033f136cdae7691c9cfc35082540832",
  ]);
});

test("sendWithRetry reports the failure when everything fails", async () => {
  const submitError = new Error("stamp cost too high");
  const lxmf = new FakeRouter({
    sendOutcomes: [
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
      { throw: NO_PROOF() },
    ],
    submitOutcomes: [{ throw: submitError }],
  });
  await assert.rejects(
    sender(lxmf, "f033f136cdae7691c9cfc35082540832")({ destinationHash: DEST }),
    submitError,
  );
});
