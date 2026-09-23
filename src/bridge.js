/**
 * @file bridge.js
 *
 * The LXMF ↔ Pi bridge (SPEC §6): owner admission and pairing, the
 * serialized inbound pipeline (commands vs prompts), reply delivery, and
 * supervision of Pi lifecycle events.
 *
 * Reply model: every *finalized* assistant message that contains text is
 * delivered as its own LXMF message while an LXMF-triggered exchange is
 * active (pi-msg's model — intermediate replies are never lost when several
 * messages were queued mid-run). `agent_settled` closes the exchange; if
 * nothing at all was delivered for it, the empty-tail recovery runs once
 * before falling back to a "done (no reply)" nudge.
 */

import {
  bridgeCommands,
  EMPTY_REPLY_RECOVERY_PROMPT,
  parseCommand,
} from "./commands.js";
import { deriveLxmfDestinationHash } from "./identity.js";
import { assistantText } from "./rpc.js";
import { errorText } from "./text.js";

/** Extension-UI methods that expect a response (dialogs to decline). */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Diagnostic sink satisfied by `console`.
 *
 * @typedef {object} Logger
 * @property {(msg: string) => void} log
 * @property {(msg: string) => void} error
 */

/**
 * Machine-managed state persistence (session pointer).
 *
 * @typedef {object} BridgeState
 * @property {() => {sessionFile: string}|null} loadSession
 * @property {(file: string) => void} saveSession
 */

/**
 * The mesh-side adapter the bridge talks to (returned by `startLxmf`, faked
 * in tests).
 *
 * @typedef {object} MeshAdapter
 * @property {EventTarget} lxmf - The LXMRouter (dispatches "message" events).
 * @property {(destHex: string, text: string, opts?: {link?: any, title?: string}) => Promise<void>} sendText
 * @property {string} identityHash
 * @property {string} deliveryHash
 */

/**
 * Local hex encoder (keeps this module testable without @reticulum/core).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toHexString(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The bridge. Wire it up with `start()`; drive readiness with
 * `setRpcReady(true)` once the RPC client answers commands.
 */
export class Bridge {
  /**
   * @param {object} options
   * @param {import("./config.js").PiLxmfConfig} options.config - Resolved configuration (`loadConfig`).
   * @param {import("./rpc.js").PiRpcClient} options.rpc
   * @param {MeshAdapter} options.mesh
   * @param {BridgeState} options.state
   * @param {Logger} [options.log] - Diagnostic sink.
   * @param {(reason: string) => void} [options.onShutdown] - Called when the bridge wants the daemon to exit.
   */
  constructor(options) {
    this.config = options.config;
    this.rpc = options.rpc;
    this.mesh = options.mesh;
    this.state = options.state;
    this.log = options.log || console;
    this.onShutdown = options.onShutdown || (() => {});

    /** The owner's Reticulum identity hash (protocol-agnostic, from config). */
    this.ownerIdentity = options.config.owner;
    /** The owner's derived lxmf.delivery destination hash (wire form). */
    this.ownerDestinationHash = deriveLxmfDestinationHash(options.config.owner);
    /** @type {string|null} */
    this.sessionName = null;
    /** @type {string|null} */
    this.lastSessionFile = null;
    /** @type {any} */
    this.lastLink = undefined;

    this.rpcReady = false;
    /** @type {{promise: Promise<void>, resolve: () => void}|null} */
    this.whenReady = null;

    this.busy = false;
    this.exchangeActive = false;
    this.sentThisExchange = 0;
    this.recovering = false;
    /** @type {string|null} */
    this.lastError = null;
    /** @type {string|null} */
    this.failedNote = null;

    this.startedAt = Date.now();
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
    this.shutdownRequested = false;
    this.subscribed = false;
  }

  /**
   * Subscribes to mesh and Pi events. Idempotent.
   */
  start() {
    if (this.subscribed) return;
    this.subscribed = true;

    this.mesh.lxmf.addEventListener("message", (/** @type {any} */ event) => {
      void this.onLxmfMessage(event);
    });

    this.rpc.addEventListener("event", (/** @type {any} */ event) => {
      this.handlePiEvent(event.detail);
    });
    this.rpc.addEventListener("ready", () => {
      this.setRpcReady(true);
    });
    this.rpc.addEventListener("restarting", (/** @type {any} */ event) => {
      this.setRpcReady(false);
      const { code, signal } = event.detail ?? {};
      void this.deliver(
        `⚠️ pi exited unexpectedly (code ${code ?? "?"} signal ${signal ?? "?"}) — restarting…`,
      );
    });
    this.rpc.addEventListener("dead", (/** @type {any} */ event) => {
      this.setRpcReady(false);
      const reason = event.detail?.reason ?? "unknown reason";
      void this.deliver(
        `⛔ pi is not recovering: ${reason} — bridge shutting down.`,
      );
      this.requestShutdown(`pi dead: ${reason}`);
    });
  }

  /**
   * Marks the RPC client usable (or unusable, during supervised restarts).
   * Inbound messages queue until ready.
   *
   * @param {boolean} ready
   */
  setRpcReady(ready) {
    if (ready && !this.rpcReady) {
      this.rpcReady = true;
      if (this.whenReady) {
        this.whenReady.resolve();
        this.whenReady = null;
      }
      return;
    }
    if (!ready && this.rpcReady) {
      this.rpcReady = false;
    }
  }

  /**
   * Resolves once `setRpcReady(true)` has been called.
   *
   * @returns {Promise<void>}
   */
  async waitReady() {
    if (this.rpcReady) return;
    if (!this.whenReady) {
      /** @type {(value?: any) => void} */
      let resolve = () => {};
      const promise = new Promise((r) => {
        resolve = r;
      });
      this.whenReady = { promise, resolve };
    }
    await this.whenReady.promise;
  }

  /**
   * Handles one inbound (signature-verified) LXMF message event.
   *
   * @param {{detail?: {message?: any, link?: any}}} event
   */
  async onLxmfMessage(event) {
    const message = event.detail?.message;
    const link = event.detail?.link;
    if (!message?.sourceHash) return;
    // The LXMF source_hash is the sender's lxmf.delivery DESTINATION hash —
    // the wire form compared against the owner's derived destination hash.
    const sourceHex = toHexString(message.sourceHash);

    if (sourceHex !== this.ownerDestinationHash) {
      this.log.log(
        `pi-lxmf: inbound from ${sourceHex}: dropped (not the owner)`,
      );
      return;
    }

    const content =
      typeof message.content === "string" ? message.content.trim() : "";
    if (!content) {
      this.log.log("pi-lxmf: inbound from owner: ignored (empty body)");
      return;
    }
    this.lastLink = link ?? this.lastLink;

    // Serialize all inbound handling so prompts and commands keep order.
    const run = this.queue
      .then(() => this.processInbound(content, link))
      .catch((e) => {
        this.log.error(`pi-lxmf: inbound handling failed: ${errorText(e)}`);
      });
    this.queue = run;
  }

  /**
   * Processes one accepted inbound message: bridge command or prompt.
   *
   * @param {string} content
   * @param {any} link
   */
  async processInbound(content, link) {
    await this.waitReady();

    const parsed = parseCommand(content);
    if (parsed) {
      if (parsed.name === "") {
        this.log.log("pi-lxmf: inbound from owner: abort (interrupt)");
        this.rpc.abort();
        await this.deliver("⛔ aborted (queue intact).");
        return;
      }
      const command = bridgeCommands[parsed.name];
      if (command) {
        this.log.log(`pi-lxmf: inbound from owner: command /${parsed.name}`);
        try {
          const result = await command.run(this.commandContext(), parsed.args);
          const text = typeof result === "string" ? result : result?.text;
          if (text) await this.deliver(text);
          if (result && typeof result === "object" && result.shutdown) {
            this.requestShutdown("owner sent /quit");
          }
        } catch (e) {
          await this.deliver(`⚠️ /${parsed.name} failed: ${errorText(e)}`);
        }
        return;
      }
      // Unknown /…: fall through — Pi dispatches extension commands and
      // skills, and anything else becomes a normal prompt.
    }

    this.log.log(
      `pi-lxmf: inbound from owner: prompt (${content.length} chars)`,
    );
    await this.sendPrompt(content, link);
  }

  /**
   * Sends a prompt to Pi, choosing `streamingBehavior` from authoritative
   * state and retrying once on the accept/steer race.
   *
   * @param {string} content
   * @param {any} link
   */
  async sendPrompt(content, link) {
    this.lastLink = link ?? this.lastLink;

    /** @type {any} */
    let state = null;
    try {
      state = await this.rpc.getState();
    } catch {
      /* between restarts or briefly unresponsive: fall back to the busy hint */
    }
    this.observeState(state);

    const streaming =
      state?.isStreaming === true || (state === null && this.busy);
    /** @type {any} */
    let response;
    // Open the exchange optimistically, before the write: pi can emit the
    // acceptance response and the run's events in the same stdout chunk, and
    // the response promise only resolves on a later microtask — events
    // handled in between must already count towards this exchange.
    this.exchangeActive = true;
    try {
      response = await this.rpc.prompt(
        content,
        streaming ? this.config.midRunBehavior : undefined,
      );
    } catch (e) {
      this.exchangeActive = false;
      await this.deliver(`⚠️ could not send prompt: ${errorText(e)}`);
      return;
    }
    if (response.success !== true) {
      const error = typeof response.error === "string" ? response.error : "";
      if (/stream/i.test(error)) {
        // A run started between our get_state and the prompt: retry queued.
        try {
          response = await this.rpc.prompt(content, this.config.midRunBehavior);
        } catch (e) {
          this.exchangeActive = false;
          await this.deliver(`⚠️ could not send prompt: ${errorText(e)}`);
          return;
        }
      }
    }
    if (response.success !== true) {
      this.exchangeActive = false;
      const error =
        typeof response.error === "string" ? response.error : "unknown error";
      await this.deliver(`⚠️ prompt rejected: ${error}`);
    }
  }

  /**
   * Handles a Pi RPC event.
   *
   * @param {any} event
   */
  handlePiEvent(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "agent_start":
        this.busy = true;
        break;
      case "agent_settled":
        this.busy = false;
        void this.onSettled();
        break;
      case "message_end": {
        if (event.message?.role !== "assistant") break;
        const text = assistantText(event.message);
        if (text && this.exchangeActive) {
          this.sentThisExchange += 1;
          void this.deliver(text);
        }
        break;
      }
      case "auto_retry_end":
        if (event.success === false && event.finalError) {
          this.lastError = String(event.finalError);
        }
        break;
      case "compaction_end":
        if (!event.aborted && !event.result && event.errorMessage) {
          this.lastError = `compaction failed: ${event.errorMessage}`;
        }
        break;
      case "extension_ui_request": {
        const method = /** @type {string} */ (event.method);
        if (!DIALOG_METHODS.has(method)) break;
        this.rpc.respondUi(event.id, { cancelled: true });
        const title = event.title ? `: ${event.title}` : "";
        void this.deliver(
          `⛔ dialog dismissed${title} (nobody is at the terminal).`,
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Closes the current exchange; runs empty-tail recovery when the owner
   * got no reply at all for it.
   */
  async onSettled() {
    if (!this.exchangeActive) return;
    const sent = this.sentThisExchange;
    this.exchangeActive = false;
    this.sentThisExchange = 0;

    if (sent > 0) {
      this.recovering = false;
      return;
    }
    if (this.lastError) {
      const error = this.lastError;
      this.lastError = null;
      this.recovering = false;
      await this.deliver(`⚠️ run failed: ${error}`);
      return;
    }
    if (!this.recovering) {
      this.recovering = true;
      // Optimistically re-open the exchange before the write: the recovery
      // run's events can arrive in the same stdout chunk as its response.
      this.exchangeActive = true;
      this.sentThisExchange = 0;
      try {
        const response = await this.rpc.prompt(EMPTY_REPLY_RECOVERY_PROMPT);
        if (response?.success !== true) {
          this.exchangeActive = false;
          this.recovering = false;
          await this.deliver("✅ done (no reply) — your turn");
        }
      } catch {
        this.exchangeActive = false;
        this.recovering = false;
        await this.deliver("✅ done (no reply) — your turn");
      }
      return;
    }
    this.recovering = false;
    await this.deliver("✅ done (no reply) — your turn");
  }

  /**
   * Records session observations (name/file) and refreshes the persisted
   * pointer + the RPC client's resume path.
   *
   * @param {any} state - `get_state` data.
   */
  observeState(state) {
    if (!state) return;
    if (state.sessionName !== undefined) {
      this.sessionName = state.sessionName ?? null;
    }
    const file = state.sessionFile;
    if (typeof file === "string" && file && file !== this.lastSessionFile) {
      this.lastSessionFile = file;
      try {
        this.state.saveSession(file);
      } catch (e) {
        this.log.error(`pi-lxmf: could not persist session pointer: ${e}`);
      }
      this.rpc.setSessionPath(file);
    }
  }

  /**
   * The command execution context handed to `bridgeCommands`.
   */
  commandContext() {
    return {
      rpc: this.rpc,
      getTitle: () => this.replyTitle(),
      getBridgeInfo: () => ({
        identityHash: this.mesh.identityHash,
        deliveryHash: this.mesh.deliveryHash,
        owner: this.ownerIdentity,
        uptimeMs: Date.now() - this.startedAt,
      }),
    };
  }

  /**
   * @returns {string} Title for the first chunk of a reply.
   */
  replyTitle() {
    return this.sessionName ?? this.config.name;
  }

  /**
   * Delivers a reply to the owner. Failed deliveries are noted and
   * prepended to the next successful one (LXMF has no side channel).
   *
   * @param {string} text
   */
  async deliver(text) {
    const payload = this.failedNote ? `${this.failedNote}\n\n${text}` : text;
    try {
      await this.mesh.sendText(this.ownerDestinationHash, payload, {
        link: this.lastLink,
        title: this.replyTitle(),
      });
      this.failedNote = null;
    } catch (e) {
      this.failedNote = `[previous reply could not be delivered: ${errorText(e)}]`;
      this.log.error(`pi-lxmf: LXMF delivery failed: ${errorText(e)}`);
    }
  }

  /**
   * @param {string} reason
   */
  requestShutdown(reason) {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    this.log.log(`pi-lxmf: shutdown requested (${reason})`);
    this.onShutdown(reason);
  }
}
