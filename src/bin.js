#!/usr/bin/env node

/**
 * @file bin.js
 *
 * The `pi-lxmf` daemon entry point: loads configuration, starts the mesh
 * side, spawns `pi --mode rpc`, wires the bridge, and stays alive until
 * signalled or told to quit over LXMF.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { Bridge } from "./bridge.js";
import { isUnderWorkdir } from "./commands.js";
import {
  listSessionPointers,
  loadConfig,
  readActiveCwd,
  readSessionPointer,
  writeActiveCwd,
  writeSessionPointer,
} from "./config.js";
import { deriveLxmfDestinationHash } from "./identity.js";
import { startLxmf } from "./lxmf.js";
import { GlmQuotaWatcher, readZaiKey } from "./quota.js";
import { PiRpcClient } from "./rpc.js";

const USAGE = `pi-lxmf — drive Pi over LXMF messaging

Usage: pi-lxmf [--config <path>] [--version]

Options:
  --config, -c <path>   Configuration file (default: $PI_LXMF_CONFIG or
                        ~/.config/pi-lxmf/config.json)
  --version, -v         Print version and exit
  --help, -h            Show this help

The daemon announces itself on the Reticulum mesh and relays messages
between the paired owner and a supervised \`pi --mode rpc\` child process.
See SPEC.md for details.`;

/**
 * @param {string[]} argv
 * @returns {{config: string|null, version: boolean, help: boolean, error: string|null}}
 */
function parseArgv(argv) {
  /** @type {{config: string|null, version: boolean, help: boolean, error: string|null}} */
  const out = { config: null, version: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      const value = argv[++i];
      if (!value) {
        out.error = `${arg} requires a path`;
        return out;
      }
      out.config = value;
    } else if (arg === "--version" || arg === "-v") {
      out.version = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      out.error = `unknown argument: ${arg}`;
      return out;
    }
  }
  return out;
}

/**
 * @param {string} label
 * @param {string} value
 */
function bannerLine(label, value) {
  console.log(`  ${label.padEnd(10)} ${value}`);
}

/** @type {boolean} */
let shuttingDown = false;

/**
 * @param {unknown} e
 * @returns {string}
 */
function errText(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * @param {string} reason
 * @param {object} parts
 * @param {import("./rpc.js").PiRpcClient|null} parts.rpc
 * @param {{stop: () => void}|null} parts.mesh
 * @param {Bridge|null} parts.bridge
 * @param {import("./config.js").PiLxmfConfig|null} [parts.config]
 */
function gracefulShutdown(reason, parts) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`pi-lxmf: shutting down (${reason})`);
  const finish = () => {
    parts.rpc?.stop();
    parts.mesh?.stop();
    process.exit(0);
  };
  // Best effort: persist the current session pointer (under the repo the
  // supervised Pi currently runs in — it may have moved via /cd) so the
  // next start resumes this session.
  const persist =
    parts.bridge && parts.rpc && parts.config
      ? parts.rpc
          .getState()
          .then((/** @type {any} */ state) => {
            if (state?.sessionFile) {
              writeSessionPointer(
                parts.config?.dataDir ?? "",
                parts.rpc?.cwd ?? parts.config?.workdir ?? "",
                state.sessionFile,
              );
            }
          })
          .catch(() => {})
      : Promise.resolve();
  persist.then(finish, finish);
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.error) {
    console.error(`pi-lxmf: ${args.error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const config = await loadConfig({ path: args.config ?? undefined });
  if (args.version) {
    console.log(config.name);
    process.exit(0);
  }

  process.on("unhandledRejection", (e) => {
    console.error("pi-lxmf: unhandled rejection:", e);
  });

  console.log(`pi-lxmf: ${config.name} starting`);
  bannerLine("workdir", config.workdir);
  bannerLine("config", config.configPath ?? "(defaults)");
  bannerLine("data", config.dataDir);

  // Mesh first: the identity and delivery destination are needed for the
  // banner, and inbound messages queue in the bridge until Pi is ready.
  const mesh = await startLxmf(config);
  bannerLine("identity", mesh.identityHash);
  bannerLine("lxmf", mesh.deliveryHash);
  bannerLine("interfaces", mesh.interfaceNames.join(", "));
  bannerLine("announce", config.name);

  bannerLine("owner (identity)", config.owner);

  // The last repo the owner /cd'ed into, if it is still usable: under the
  // daemon workdir (the trust root) and still an existing directory.
  // Otherwise fall back to the workdir itself.
  /** @type {string} */
  let startCwd = config.workdir;
  const persistedCwd = readActiveCwd(config.dataDir);
  if (persistedCwd && persistedCwd !== config.workdir) {
    let usable = isUnderWorkdir(config.workdir, persistedCwd);
    if (usable) {
      try {
        usable = statSync(persistedCwd).isDirectory();
      } catch {
        usable = false;
      }
    }
    if (usable) {
      startCwd = persistedCwd;
    } else {
      console.log(
        `pi-lxmf: persisted cwd ${persistedCwd} is no longer under workdir — starting in workdir`,
      );
    }
  }
  if (startCwd !== config.workdir) {
    bannerLine("cwd", startCwd);
  }

  const sessionPointer = readSessionPointer(config.dataDir, startCwd);
  if (sessionPointer) {
    bannerLine("resume", basename(sessionPointer.sessionFile));
  }

  /** @type {import("./rpc.js").PiRpcClient|null} */
  let rpc = null;
  /** @type {Bridge|null} */
  let bridge = null;
  const shutdown = (/** @type {string} */ reason) =>
    gracefulShutdown(reason, { rpc, mesh, bridge, config });

  rpc = new PiRpcClient({
    piBin: config.piBin,
    model: config.model,
    cwd: startCwd,
    sessionPath: sessionPointer?.sessionFile ?? null,
  });

  bridge = new Bridge({
    config,
    rpc,
    mesh,
    state: {
      loadSession: (workdir) => readSessionPointer(config.dataDir, workdir),
      saveSession: (workdir, file) =>
        writeSessionPointer(config.dataDir, workdir, file),
      saveCwd: (cwd) => writeActiveCwd(config.dataDir, cwd),
      listSessions: () => listSessionPointers(config.dataDir),
    },
    quotaWatcher: new GlmQuotaWatcher({
      ownerDestinationHash: deriveLxmfDestinationHash(config.owner),
      sendText: (destHex, text) =>
        mesh.sendText(destHex, text, { title: config.name }),
      log: console,
      apiKey: readZaiKey(),
    }),
    onShutdown: shutdown,
  });
  bridge.start();

  try {
    await rpc.start();
  } catch (e) {
    console.error(`pi-lxmf: ${errText(e)}`);
    mesh.stop();
    process.exit(1);
  }
  bridge.setRpcReady(true);
  console.log("pi-lxmf: ready — listening for LXMF messages");

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // The daemon is fully available: tell the owner (they may be waiting on
  // a restart). Delivery failures are noted, not fatal.
  await bridge.notifyStartup(sessionPointer?.sessionFile ?? null);

  // Run until signalled or shut down over LXMF.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("pi-lxmf: fatal:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
