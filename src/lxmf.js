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
import { LXMessage, LXMRouter } from "@reticulum/lxmf";
import {
  AutoInterface,
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "@reticulum/node";
import { createBz2 } from "./bz2.js";
import { chunkText } from "./text.js";

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

  return {
    rns,
    lxmf,
    identity,
    identityHash,
    deliveryHash,
    interfaceNames,
    sendText,
    stop() {
      lxmf.stopAnnouncing();
      if (syncTimer) clearInterval(syncTimer);
    },
  };
}
