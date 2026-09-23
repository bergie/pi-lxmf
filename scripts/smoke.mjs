#!/usr/bin/env node
/**
 * @file smoke.mjs
 *
 * End-to-end smoketest for the pi-lxmf daemon, run manually against a
 * local rnsd shared instance (see SPEC §12):
 *
 *   node scripts/smoke.mjs
 *
 * What it exercises, all over real LXMF through rnsd:
 *  1. Daemon startup: config, shared-instance attach, announce, banner.
 *  2. Owner admission by Reticulum identity hash (the config `owner` field
 *     is preconfigured with the fake owner's identity hash, exercising the
 *     identity → lxmf.destination-hash derivation end-to-end).
 *  3. A prompt round-trip through a fake `pi --mode rpc` child
 *     (`scripts/fake-pi.mjs`) — assistant reply delivered back over LXMF.
 *  4. The `/help` bridge command (no LLM turn).
 *  5. Reply chunking (6000-char reply with `chunkChars: 100`).
 *
 * The daemon announces itself to whatever mesh the local rnsd is attached
 * to; use an obviously-test `name` in environments where that matters.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromHex, Identity, Reticulum, toHex } from "@reticulum/core";
import { LXMessage, LXMRouter } from "@reticulum/lxmf";
import { FileStorageAdapter, LocalClientInterface } from "@reticulum/node";

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), "pi-lxmf-smoke-"));
let daemon = null;
let failed = false;

/**
 * @param {string} label
 * @param {boolean} ok
 */
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

try {
  // --- The fake pi binary (shell wrapper around fake-pi.mjs) -------------
  const fakePi = join(work, "fake-pi.sh");
  writeFileSync(fakePi, `#!/usr/bin/sh\nexec node ${root}/fake-pi.mjs "$@"\n`);
  chmodSync(fakePi, 0o755);

  // --- The fake owner: a second LXMF node on the same rnsd ----------------
  const ownerRns = new Reticulum({
    storageAdapter: new FileStorageAdapter(join(work, "owner-storage")),
  });
  const shared = await LocalClientInterface.connectToSharedInstance();
  if (!shared)
    throw new Error("no rnsd shared instance available — start rnsd first");
  ownerRns.addInterface(shared, true);
  const ownerIdentity = await Identity.loadOrGenerate(ownerRns.storage);
  const ownerLxmf = new LXMRouter(ownerIdentity, ownerRns);
  await ownerLxmf.init();
  console.log(
    `      owner lxmf.delivery: ${toHex(ownerLxmf.deliveryDest.destinationHash)}`,
  );

  /** @type {Array<{content: string, title?: string}>} */
  const received = [];
  ownerLxmf.addEventListener("message", (event) => {
    received.push({
      content: event.detail.message.content,
      title: event.detail.message.title,
    });
  });

  // --- Daemon config (needs the owner's identity hash) --------------------
  const configPath = join(work, "config.json");
  const dataDir = join(work, "data");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        name: "pi-lxmf smoke test",
        workdir: work,
        piBin: fakePi,
        dataDir,
        chunkChars: 100,
        announceIntervalSec: 60,
        owner: toHex(ownerIdentity.identityHash),
      },
      null,
      2,
    )}\n`,
  );

  // --- Start the daemon ---------------------------------------------------
  daemon = spawn(
    process.execPath,
    [join(repo, "src", "bin.js"), "--config", configPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logLines = [];
  let daemonReady = false;
  /** @type {string|null} */
  let daemonLxmfHash = null;
  daemon.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line) continue;
      logLines.push(line);
      const hashMatch = line.match(/\blxmf\s+([0-9a-f]{32})/);
      if (hashMatch) daemonLxmfHash = hashMatch[1];
      if (line.includes("ready — listening")) daemonReady = true;
    }
  });
  daemon.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    if (!/Reticulum|LXMF|announce/i.test(text)) return; // mesh lib chatter
    logLines.push(text.trimEnd());
  });

  const deadline = Date.now() + 60000;
  while (!(daemonReady && daemonLxmfHash) && Date.now() < deadline) {
    await sleep(200);
    if (daemon.exitCode !== null) break;
  }
  check(
    "daemon started, announced and reached ready",
    Boolean(daemonReady && daemonLxmfHash),
  );
  if (!daemonLxmfHash)
    throw new Error(`daemon did not start:\n${logLines.join("\n")}`);
  console.log(`      daemon lxmf.delivery: ${daemonLxmfHash}`);

  /**
   * Learns the daemon's identity from its announce (forwarded by rnsd to
   * us as a local client).
   *
   * @param {Uint8Array} destinationHash
   */
  async function waitForPath(destinationHash) {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (await ownerRns.transport.recallIdentity(destinationHash)) return true;
      await sleep(500);
    }
    return false;
  }

  check(
    "owner learned the daemon identity from the announce",
    await waitForPath(fromHex(daemonLxmfHash)),
  );

  /**
   * @param {string} text
   */
  async function sendToDaemon(text) {
    const message = new LXMessage({
      sourceHash: ownerLxmf.deliveryDest.destinationHash,
      destinationHash: fromHex(daemonLxmfHash),
      content: text,
    });
    await ownerLxmf.send(message, ownerIdentity);
  }

  // --- 1. Prompt round-trip (owner admitted by identity hash) --------------
  await sendToDaemon("hello bridge");
  const echoUntil = Date.now() + 15000;
  while (
    Date.now() < echoUntil &&
    !received.some((m) => m.content === "You said: hello bridge")
  ) {
    await sleep(200);
  }
  const echo = received.find((m) => m.content === "You said: hello bridge");
  check("prompt round-trip through fake pi", Boolean(echo));
  if (!echo) {
    console.log("      --- daemon log ---");
    for (const line of logLines) console.log(`      ${line}`);
  }
  check("reply titled with the session name", echo?.title === "smoke");

  // --- 2. /help (no LLM turn) ----------------------------------------------
  await sendToDaemon("/help");
  const helpUntil = Date.now() + 15000;
  while (
    Date.now() < helpUntil &&
    !received.some((m) => /Bridge commands:/.test(m.content))
  ) {
    await sleep(200);
  }
  check(
    "bridge command /help answered",
    received.some((m) => /Bridge commands:/.test(m.content)),
  );

  // --- 3. Chunking ----------------------------------------------------------
  const before = received.length;
  await sendToDaemon("LONG please");
  const totalChunks = Math.ceil(6000 / 100);
  const longUntil = Date.now() + 60000;
  while (Date.now() < longUntil && received.length - before < totalChunks)
    await sleep(200);
  const longChunks = received.slice(before).map((m) => m.content);
  check(
    "long reply chunked at 100 chars",
    longChunks.length === totalChunks &&
      longChunks
        .slice(0, -1)
        .every((c) => c.length <= 130 && /\[… \d+\/\d+\]$/.test(c)) &&
      !/\[… /.test(longChunks.at(-1) ?? ""),
  );
  console.log(`      received ${longChunks.length}/${totalChunks} chunks`);

  // --- Wrap up ---------------------------------------------------------------
  console.log(
    `      config owner (identity): ${JSON.parse(readFileSync(configPath, "utf8")).owner}`,
  );
} catch (e) {
  check(`smoke crashed: ${e?.message ?? e}`, false);
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await sleep(1500);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  rmSync(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
