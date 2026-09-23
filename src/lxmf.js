/**
 * @file lxmf.js
 *
 * The LXMF/mesh side of the bridge (SPEC §5): persistent identity,
 * interface bootstrap (shared instance → AutoInterface → TCP), the
 * `LXMRouter` with periodic announcing, optional propagation-node sync,
 * and chunked outbound message delivery.
 *
 * The wiring mirrors reticulum-js's `examples/lxmf_echobot.js`; see
 * `../reticulum-js/packages/lxmf/src/router.js` for the router API.
 */

import { join } from "node:path";
import { fromHex, Identity, Reticulum, toHex } from "@reticulum/core";
import { LXMessage, LXMFConstants, LXMRouter } from "@reticulum/lxmf";
import {
  AutoInterface,
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "@reticulum/node";
import { createBz2 } from "./bz2.js";
import { chunkText } from "./text.js";

/**
 * Attaches diagnostic logging to the inbound LXMF choke points that the
 * bridge itself can't see: packets that decrypt but never dispatch.
 *
 * The `lxmf.delivery` destination emits a `"data"` event the instant a
 * single-packet message decrypts — before the router has resolved the
 * sender's identity. When the identity is UNKNOWN the router parks the
 * message and solicits a path/announce, and it is only dispatched once
 * that announce arrives. This is the most common reason a sender sees
 * its packet acknowledged but the bridge never logs receiving anything,
 * so we surface it here (along with unparseable packets) rather than at
 * the bridge, which only ever sees successfully dispatched messages.
 *
 * Normal, successfully-dispatched packets are intentionally silent here —
 * the bridge logs their disposition (ignored / command / prompt) where it
 * actually decides what to do with them.
 *
 * The router's `"peer"` event fires when an announce (or inbound-link
 * LINKIDENTIFY) makes an identity available, so a parked message can be
 * correlated with the announce that released it.
 *
 * Ported from signalk-reticulum's `attachInboundDiagnostics`, where this
 * instrumentation proved out the identity-parking failure mode.
 *
 * @param {LXMRouter} lxmf - An initialised router.
 * @param {(msg: string) => void} [log] - Diagnostic sink.
 * @returns {() => void} unsubscribe
 */
export function attachInboundDiagnostics(lxmf, log = () => {}) {
  const onData = async (/** @type {any} */ event) => {
    const plaintext = event?.detail?.plaintext;
    if (!plaintext) return;
    try {
      const parsed = await LXMessage.deserialize(
        plaintext,
        lxmf.deliveryDest?.destinationHash ?? undefined,
      );
      const known = await lxmf.rns.transport.recallIdentity(parsed.sourceHash);
      if (!known) {
        log(
          `pi-lxmf: inbound packet from ${toHex(parsed.sourceHash || [])} ` +
            `(${plaintext.length} bytes) parked — sender identity unknown, ` +
            `waiting for announce/path`,
        );
      }
    } catch (e) {
      log(
        `pi-lxmf: inbound packet (${plaintext.length} bytes) could not be ` +
          `parsed: ${e instanceof Error ? e.message : e}`,
      );
    }
  };
  /** @type {any} */ (lxmf.deliveryDest).addEventListener("data", onData);

  const onPeer = (/** @type {any} */ event) => {
    const destinationHash = event?.detail?.destinationHash;
    if (destinationHash) {
      log(`pi-lxmf: learned LXMF peer ${toHex(destinationHash)}`);
    }
  };
  lxmf.addEventListener("peer", onPeer);

  return () => {
    try {
      /** @type {any} */ (lxmf.deliveryDest)?.removeEventListener(
        "data",
        onData,
      );
    } catch {
      /* best effort */
    }
    try {
      lxmf.removeEventListener("peer", onPeer);
    } catch {
      /* best effort */
    }
  };
}

/**
 * Starts the mesh side. Resolves once the LXMF delivery destination is
 * registered and announcing has begun.
 *
 * @param {import("./config.js").PiLxmfConfig} config - Resolved configuration (`loadConfig` output).
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] - Diagnostic sink.
 * @returns {Promise<{
 *   rns: Reticulum,
 *   lxmf: LXMRouter,
 *   identity: Identity,
 *   identityHash: string,
 *   deliveryHash: string,
 *   interfaceNames: string[],
 *   sendText: (destinationHex: string, text: string, options?: {link?: any, title?: string}) => Promise<void>,
 *   sendReaction: (destinationHex: string, targetMessageId: Uint8Array, emoji: string, options?: {link?: any}) => Promise<void>,
 *   verifySender: (message: LXMessage) => Promise<"verified"|"unknown"|"invalid">,
 *   stop: () => void
 * }>}
 */
export async function startLxmf(config, options = {}) {
  const log = options.log || ((msg) => console.log(msg));

  // rngit-style Resources (and oversized LXMF bodies) compress with bz2;
  // without a provider they transfer uncompressed over slow links.
  const bz2 = await createBz2();

  const storageDir = join(config.dataDir, "storage");
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter(storageDir),
    compressionProvider: bz2,
  });

  /** @type {string[]} */
  const interfaceNames = [];
  // Attaching to a local rnsd shared instance only works for 0-hop local
  // traffic in some setups: a shared rnsd that does not forward routed
  // (multi-hop) traffic to its local clients (observed Termux↔Columba,
  // where the daemon's announces reach the mesh but inbound link requests
  // die at the rnsd) silently blackholes every remote message.
  // `skipSharedInstance` opts out in favour of own interfaces.
  const shared = config.skipSharedInstance
    ? null
    : await LocalClientInterface.connectToSharedInstance();
  if (shared) {
    // The generated @reticulum types hold two path identities for Interface
    // (src/ vs types/), which strict tsc rejects; the runtime types match.
    rns.addInterface(/** @type {any} */ (shared), true);
    interfaceNames.push("shared-instance");
    log("pi-lxmf: attached to local rnsd shared instance");
  } else {
    const auto = new AutoInterface({ name: "auto" });
    await /** @type {any} */ (auto).connect();
    rns.addInterface(/** @type {any} */ (auto), true);
    interfaceNames.push("auto");
    if (config.rnsHost && config.rnsPort) {
      const tcp = new TCPClientInterface({
        host: config.rnsHost,
        port: config.rnsPort,
      });
      await /** @type {any} */ (tcp).connect();
      rns.addInterface(/** @type {any} */ (tcp), true);
      interfaceNames.push(`tcp:${config.rnsHost}:${config.rnsPort}`);
    }
  }

  // The node's stable LXMF identity: loaded from (or created in) the
  // persistent storage directory. This hash IS the node's address.
  const identity = await Identity.loadOrGenerate(rns.storage);
  const identityHash = toHex(identity.identityHash);
  log(`pi-lxmf: identity ${identityHash}`);

  const lxmf = new LXMRouter(identity, rns);
  await lxmf.init();
  // init() registers the delivery destination; narrow the nullable types
  // and capture a non-null alias usable from the sendText closure.
  const registered = lxmf.deliveryDest;
  if (!registered) {
    throw new Error("LXMRouter.init() did not register lxmf.delivery");
  }
  const deliveryDest = registered;
  const deliveryHash = toHex(
    /** @type {Uint8Array} */ (deliveryDest.destinationHash),
  );
  log(`pi-lxmf: lxmf.delivery destination ${deliveryHash}`);

  // Instrument the inbound path so a silently-parked or failing message is
  // visible in the daemon log (see attachInboundDiagnostics).
  const detachDiagnostics = attachInboundDiagnostics(lxmf, log);

  // Immediate announce + periodic re-announce so cached mesh paths stay
  // fresh and peers (Sideband/Nomadnet) show our display name.
  await lxmf.startAnnouncing(config.name, {
    intervalMs: config.announceIntervalSec
      ? config.announceIntervalSec * 1000
      : undefined,
  });
  log(`pi-lxmf: announcing as "${config.name}"`);

  // Optional propagation-node integration: outbound submits go through the
  // node when a direct link cannot be established, and a periodic sync
  // pulls messages that arrived while this daemon was down.
  if (config.propagationNode) {
    lxmf.setOutboundPropagationNode(fromHex(config.propagationNode));
    log(`pi-lxmf: outbound propagation node ${config.propagationNode}`);
  }
  /** @type {NodeJS.Timeout|null} */
  let syncTimer = null;
  if (config.propagationNode && config.syncIntervalSec > 0) {
    syncTimer = setInterval(() => {
      lxmf
        .syncFromPropagationNode(identity)
        .then((/** @type {{received?: number}} */ res) => {
          if ((res?.received ?? 0) > 0) {
            log(
              `pi-lxmf: propagation sync delivered ${res.received} message(s)`,
            );
          }
        })
        .catch((/** @type {Error} */ e) => {
          log(`pi-lxmf: propagation sync failed: ${e.message}`);
        });
    }, config.syncIntervalSec * 1000);
    syncTimer.unref();
    log(`pi-lxmf: propagation sync every ${config.syncIntervalSec}s`);
  }

  /**
   * Sends `text` to `destinationHex` (a 32-hex lxmf.delivery source hash),
   * chunked to `chunkChars`, titled on the first chunk. A failed send is
   * retried once over the same path, then once more opportunistically
   * (without the link) — battery-conscious mobile clients tear their link
   * down right after their message is acknowledged, so the arrival link can
   * be gone by reply time; the same `LXMessage` object is re-sent so both
   * wire copies share one message id and a deduplicating client shows the
   * reply once (learned in signalk-reticulum's deliverer).
   *
   * @param {string} destinationHex
   * @param {string} text
   * @param {{link?: any, title?: string}} [sendOptions]
   */
  async function sendText(destinationHex, text, sendOptions = {}) {
    const chunks = chunkText(text, config.chunkChars);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const content =
        chunks.length > 1 && !isLast
          ? `${chunks[i]}\n\n[… ${i + 1}/${chunks.length}]`
          : chunks[i];
      const message = new LXMessage({
        // destinationHash is always set once init() registered the destination.
        sourceHash: /** @type {Uint8Array} */ (deliveryDest.destinationHash),
        destinationHash: fromHex(destinationHex),
        content,
        ...(i === 0 && sendOptions.title ? { title: sendOptions.title } : {}),
      });
      await sendWithRetry(message, sendOptions.link);
    }
  }

  /**
   * Sends an LXMF reaction (FIELD_REACTION, §5.9.8) to `destinationHex`,
   * targeting the message whose `messageId` is `targetMessageId`. The
   * reaction field is rendered natively by Sideband/NomadNet (confirmed in
   * live testing); no `content` is set so no separate chat bubble is
   * produced alongside the reaction. Reuses `sendWithRetry` for the same
   * retry-once path as `sendText` (same message object across retries → one
   * message id).
   *
   * @param {string} destinationHex
   * @param {Uint8Array} targetMessageId - The `message_id` of the message being reacted to.
   * @param {string} emoji
   * @param {{link?: any}} [sendOptions]
   */
  async function sendReaction(
    destinationHex,
    targetMessageId,
    emoji,
    sendOptions = {},
  ) {
    const reaction = new Map();
    reaction.set(LXMFConstants.REACTION_TO, targetMessageId);
    reaction.set(
      LXMFConstants.REACTION_CONTENT,
      new TextEncoder().encode(emoji),
    );
    const fields = new Map();
    fields.set(LXMFConstants.FIELD_REACTION, reaction);
    const message = new LXMessage({
      sourceHash: /** @type {Uint8Array} */ (deliveryDest.destinationHash),
      destinationHash: fromHex(destinationHex),
      fields,
    });
    await sendWithRetry(message, sendOptions.link);
  }

  /**
   * @param {LXMessage} message
   * @param {any} [link]
   */
  async function sendWithRetry(message, link) {
    try {
      await lxmf.send(message, identity, link);
    } catch (e) {
      log(
        `pi-lxmf: LXMF send failed (${e instanceof Error ? e.message : e}), retrying once`,
      );
      try {
        await lxmf.send(message, identity, link);
      } catch (e2) {
        // The arrival link is likely gone (the peer closed it after its
        // message was acknowledged). Retry without it: `LXMRouter.send`
        // then establishes a fresh DIRECT link, falling back to an
        // opportunistic packet. Same message object → same message id, so
        // a deduplicating client renders the reply once.
        log(
          `pi-lxmf: link retry failed (${e2 instanceof Error ? e2.message : e2}), retrying without link`,
        );
        await lxmf.send(message, identity, null);
      }
    }
  }

  /**
   * Verifies the signature of an inbound `message` against the sender's
   * recalled identity. The router verifies signatures on the direct-delivery
   * path, but a message pulled in via `syncFromPropagationNode` whose sender
   * identity is not yet recalled is dispatched WITHOUT verification
   * (mirroring Python's `SOURCE_UNKNOWN` handling). The bridge must not rely
   * on the router for this on the sync path, so it calls here to close the
   * gap: a message is admitted only when this returns `"verified"`.
   *
   * @param {LXMessage} message
   * @returns {Promise<"verified"|"unknown"|"invalid">}
   *   `"verified"` — signature checks against the recalled sender identity.
   *   `"unknown"`   — sender identity not recalled (parked); admission would
   *                  be unverified, so the caller should drop and log.
   *   `"invalid"`   — signature failed cryptographic proof.
   */
  async function verifySender(message) {
    const sender = await lxmf.rns.transport.recallIdentity(message.sourceHash);
    if (!sender) return "unknown";
    return (await message.verifySignature(sender)) ? "verified" : "invalid";
  }

  return {
    rns,
    lxmf,
    identity,
    identityHash,
    deliveryHash,
    interfaceNames,
    sendText,
    sendReaction,
    verifySender,
    stop() {
      detachDiagnostics();
      lxmf.stopAnnouncing();
      if (syncTimer) clearInterval(syncTimer);
    },
  };
}
