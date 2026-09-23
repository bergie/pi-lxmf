/**
 * Tests for configuration loading, validation and the machine-managed
 * state files (session pointer).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConfigError,
  defaultConfigPath,
  defaultDataDir,
  loadConfig,
  readSessionPointer,
  writeSessionPointer,
} from "../src/config.js";

/**
 * @param {Record<string, unknown>} [raw]
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function loadWith(raw = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-lxmf-cfg-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(raw));
  try {
    return await loadConfig({ path: file, ...options });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults when no config file exists (owner required)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lxmf-cfg-"));
  await assert.rejects(
    loadConfig({
      path: join(dir, "missing.json"),
      env: {},
      cwd: "/tmp/project",
    }),
    /"owner" is required/,
  );
  const config = await loadConfig({
    path: join(dir, "missing.json"),
    env: {},
    cwd: "/tmp/project",
    // Simulate the env-var config override for the required owner.
  }).catch(() => null);
  assert.equal(config, null);
  rmSync(dir, { recursive: true, force: true });
});

test("defaults resolve with owner set", async () => {
  const config = await loadWith(
    { owner: "abcdef0123456789abcdef0123456789" },
    {
      env: {},
      cwd: "/tmp/project",
    },
  );
  assert.equal(config.owner, "abcdef0123456789abcdef0123456789");
  assert.match(config.name, /^pi-lxmf \d+\.\d+\.\d+/);
  assert.equal(config.workdir, "/tmp/project");
  assert.equal(config.model, null);
  assert.equal(config.piBin, "pi");
  assert.equal(config.dataDir, defaultDataDir({}));
  assert.equal(config.midRunBehavior, "steer");
  assert.equal(config.chunkChars, 2500);
  assert.equal(config.announceIntervalSec, null);
  assert.ok(config.configPath); // loadWith writes a real config file
});

test("XDG paths and PI_LXMF_CONFIG override", () => {
  assert.equal(
    defaultConfigPath({ PI_LXMF_CONFIG: "/custom/config.json" }),
    "/custom/config.json",
  );
  assert.equal(
    defaultConfigPath({ XDG_CONFIG_HOME: "/xdg" }),
    join("/xdg", "pi-lxmf", "config.json"),
  );
  assert.equal(
    defaultDataDir({ XDG_DATA_HOME: "/xdg-data" }),
    join("/xdg-data", "pi-lxmf"),
  );
});

test("loads and normalises values", async () => {
  const config = await loadWith({
    owner: "ABCDEF0123456789ABCDEF0123456789",
    name: "my pi",
    workdir: "/srv/project",
    model: "anthropic/claude-sonnet-4-5",
    midRunBehavior: "followUp",
    chunkChars: 1200,
    announceIntervalSec: 900,
    rnsHost: "127.0.0.1",
    rnsPort: 42424,
    skipSharedInstance: true,
    propagationNode: "1234567890abcdef1234567890abcdef",
    syncIntervalSec: 60,
  });
  assert.equal(config.owner, "abcdef0123456789abcdef0123456789");
  assert.equal(config.name, "my pi");
  assert.equal(config.workdir, "/srv/project");
  assert.equal(config.model, "anthropic/claude-sonnet-4-5");
  assert.equal(config.midRunBehavior, "followUp");
  assert.equal(config.chunkChars, 1200);
  assert.equal(config.announceIntervalSec, 900);
  assert.equal(config.rnsPort, 42424);
  assert.equal(config.skipSharedInstance, true);
  assert.equal(config.propagationNode, "1234567890abcdef1234567890abcdef");
  assert.equal(config.syncIntervalSec, 60);
  assert.ok(config.configPath);
});

test("rejects invalid values", async () => {
  await assert.rejects(loadWith({ owner: "nothex" }), ConfigError);
  await assert.rejects(loadWith({ propagationNode: 42 }), ConfigError);
  await assert.rejects(loadWith({ midRunBehavior: "interrupt" }), ConfigError);
  await assert.rejects(loadWith({ chunkChars: 0 }), ConfigError);
  await assert.rejects(loadWith({ chunkChars: 1.5 }), ConfigError);
  await assert.rejects(loadWith({ announceIntervalSec: 10 }), ConfigError);
});

test("rejects broken JSON and non-objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lxmf-cfg-"));
  const file = join(dir, "config.json");
  writeFileSync(file, "{ nope");
  await assert.rejects(loadConfig({ path: file }), ConfigError);
  writeFileSync(file, "[1,2,3]");
  await assert.rejects(loadConfig({ path: file }), ConfigError);
  rmSync(dir, { recursive: true, force: true });
});

test("warns about unknown keys", async () => {
  /** @type {string[]} */
  const warnings = [];
  const config = await loadWith(
    { owner: "abcdef0123456789abcdef0123456789", owners: "x" },
    { warn: (/** @type {string} */ msg) => warnings.push(msg) },
  );
  assert.equal(config.owner, "abcdef0123456789abcdef0123456789");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown config key "owners"/);
});

test("skipSharedInstance defaults to false and rejects non-booleans", async () => {
  const config = await loadWith({
    owner: "abcdef0123456789abcdef0123456789",
  });
  assert.equal(config.skipSharedInstance, false);
  await assert.rejects(
    loadWith({
      owner: "abcdef0123456789abcdef0123456789",
      skipSharedInstance: "yes",
    }),
    /skipSharedInstance.*boolean/,
  );
});

test("session pointer round-trip and corrupt tolerance", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lxmf-state-"));
  try {
    assert.equal(readSessionPointer(dir), null);
    writeSessionPointer(dir, "/sessions/abc.jsonl");
    assert.deepEqual(readSessionPointer(dir), {
      sessionFile: "/sessions/abc.jsonl",
    });
    // Corrupt state reads as null instead of throwing.
    writeFileSync(join(dir, "session"), "{broken");
    assert.equal(readSessionPointer(dir), null);
    // A dataDir that does not exist yet is fine.
    mkdirSync(join(dir, "nested"));
    assert.equal(readSessionPointer(join(dir, "nested")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
