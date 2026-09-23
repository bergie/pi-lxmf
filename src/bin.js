#!/usr/bin/env node

/**
 * @file bin.js
 *
 * The `pi-lxmf` daemon entry point: loads configuration, starts the mesh
 * side, spawns `pi --mode rpc`, wires the bridge, and stays alive until
 * signalled or told to quit over LXMF.
 */

import { basename } from "node:path";
import { Bridge } from "./bridge.js";
import {
  loadConfig,
  readSessionPointer,
  writeSessionPointer,
} from "./config.js";
import { startLxmf } from "./lxmf.js";
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
  // Best effort: persist the current session pointer so the next start
  // resumes this session.
  const persist =
    parts.bridge && parts.rpc && parts.config
      ? parts.rpc
          .getState()
          .then((/** @type {any} */ state) => {
            if (state?.sessionFile) {
              writeSessionPointer(
                parts.config?.dataDir ?? "",
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
  bannerLine("announce", config.name);

  bannerLine("owner (identity)", config.owner);

  const sessionPointer = readSessionPointer(config.dataDir);
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
    cwd: config.workdir,
    sessionPath: sessionPointer?.sessionFile ?? null,
  });

  bridge = new Bridge({
    config,
    rpc,
    mesh,
    state: {
      loadSession: () => readSessionPointer(config.dataDir),
      saveSession: (file) => writeSessionPointer(config.dataDir, file),
    },
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

  // Run until signalled or shut down over LXMF.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("pi-lxmf: fatal:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
