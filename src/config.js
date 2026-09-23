/**
 * @file config.js
 *
 * Configuration loading/validation and the small machine-managed state
 * files (owner pairing, Pi session pointer) described in SPEC §8.
 *
 * Config resolution order for the file itself: explicit `path` argument,
 * `$PI_LXMF_CONFIG`, then `$XDG_CONFIG_HOME/pi-lxmf/config.json`
 * (default `~/.config/pi-lxmf/config.json`). A missing file is not an
 * error — the daemon runs on defaults (and first-contact pairing).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Thrown for unusable configuration (bad path, bad JSON, invalid values). */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {string} [file]
   */
  constructor(message, file) {
    super(file ? `${message} (${file})` : message);
    this.name = "ConfigError";
    this.file = file;
  }
}

/** 16-byte destination/source hashes as 32 lowercase hex chars. */
const HEX32_RE = /^[0-9a-fA-F]{32}$/;

/**
 * The resolved daemon configuration (output of {@link loadConfig}).
 *
 * @typedef {object} PiLxmfConfig
 * @property {string|null} owner - Paired owner's 32-hex source hash.
 * @property {string} name - Announce display name.
 * @property {string} workdir - Project directory Pi runs in.
 * @property {string|null} model - `--model` pattern passed to Pi.
 * @property {string} piBin - Pi binary.
 * @property {string} dataDir - State root (storage, owner, session pointer).
 * @property {string|null} rnsHost - rnsd TCP interface host (fallback).
 * @property {number|null} rnsPort - rnsd TCP interface port (fallback).
 * @property {string|null} propagationNode - `lxmf.propagation` hash.
 * @property {number} syncIntervalSec - Propagation sync cadence (0 = off).
 * @property {"steer"|"followUp"} midRunBehavior - streamingBehavior for mid-run prompts.
 * @property {number} chunkChars - Max characters per outbound LXMF message.
 * @property {number|null} announceIntervalSec - Re-announce cadence.
 * @property {string|null} configPath - Config file the values came from.
 */

/**
 * Validates and normalises a 32-hex destination hash.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string} lowercase hex
 */
function hashField(value, field) {
  if (typeof value !== "string" || !HEX32_RE.test(value.trim())) {
    throw new ConfigError(
      `Config field "${field}" must be a 32-hex-character destination hash, got: ${JSON.stringify(value)}`,
    );
  }
  return value.trim().toLowerCase();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} fallback
 * @param {number} [min]
 * @returns {number}
 */
function intField(value, field, fallback, min = 0) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || Math.floor(n) !== n) {
    throw new ConfigError(
      `Config field "${field}" must be an integer >= ${min}, got: ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/**
 * Default config file path (`$PI_LXMF_CONFIG`, then XDG).
 *
 * @param {Record<string, string|undefined>} [env] - Defaults to `process.env`.
 * @returns {string}
 */
export function defaultConfigPath(env = process.env) {
  if (env.PI_LXMF_CONFIG) return env.PI_LXMF_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pi-lxmf", "config.json");
}

/**
 * Default state/data directory (`$XDG_DATA_HOME/pi-lxmf`).
 *
 * @param {Record<string, string|undefined>} [env] - Defaults to `process.env`.
 * @returns {string}
 */
export function defaultDataDir(env = process.env) {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "pi-lxmf");
}

/**
 * Known config keys and their validators/defaults. Used both to build the
 * resolved config and to warn about typos in unknown keys.
 *
 * @type {Record<string, {required?: boolean}>}
 */
const KNOWN_KEYS = {
  owner: {},
  name: {},
  workdir: {},
  model: {},
  piBin: {},
  dataDir: {},
  rnsHost: {},
  rnsPort: {},
  propagationNode: {},
  syncIntervalSec: {},
  midRunBehavior: {},
  chunkChars: {},
  announceIntervalSec: {},
};

/**
 * Loads, validates and resolves the daemon configuration.
 *
 * @param {object} [options]
 * @param {string} [options.path] - Explicit config file path (highest precedence).
 * @param {Record<string, string|undefined>} [options.env] - Defaults to `process.env`.
 * @param {string} [options.cwd] - Default for `workdir`. Defaults to `process.cwd()`.
 * @param {(msg: string) => void} [options.warn] - Sink for warnings (unknown keys). Defaults to `console.error`.
 * @returns {Promise<PiLxmfConfig>}
 */
export async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warn = options.warn ?? console.error;
  const file = options.path || defaultConfigPath(env);

  /** @type {Record<string, unknown>} */
  let raw = {};
  /** @type {string|null} */
  let configPath = null;
  if (existsSync(file)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw new ConfigError(`Cannot read config file: ${e}`, file);
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ConfigError(`Config file is not valid JSON: ${e}`, file);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError("Config file must contain a JSON object", file);
    }
    configPath = file;
    for (const key of Object.keys(raw)) {
      if (!(key in KNOWN_KEYS)) {
        warn(`pi-lxmf: unknown config key "${key}" ignored in ${file}`);
      }
    }
  }

  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  const version = /** @type {{version?: string}} */ (pkg).version ?? "0.0.0";

  const midRunBehavior =
    raw.midRunBehavior === undefined || raw.midRunBehavior === null
      ? "steer"
      : raw.midRunBehavior;
  if (midRunBehavior !== "steer" && midRunBehavior !== "followUp") {
    throw new ConfigError(
      `Config field "midRunBehavior" must be "steer" or "followUp", got: ${JSON.stringify(raw.midRunBehavior)}`,
    );
  }

  return {
    owner:
      raw.owner === undefined || raw.owner === null
        ? null
        : hashField(raw.owner, "owner"),
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : `pi-lxmf ${version}`,
    workdir:
      typeof raw.workdir === "string" && raw.workdir.trim() ? raw.workdir : cwd,
    model:
      typeof raw.model === "string" && raw.model.trim()
        ? raw.model.trim()
        : null,
    piBin:
      typeof raw.piBin === "string" && raw.piBin.trim()
        ? raw.piBin.trim()
        : "pi",
    dataDir:
      typeof raw.dataDir === "string" && raw.dataDir.trim()
        ? raw.dataDir
        : defaultDataDir(env),
    rnsHost:
      typeof raw.rnsHost === "string" && raw.rnsHost.trim()
        ? raw.rnsHost.trim()
        : null,
    rnsPort:
      raw.rnsPort === undefined || raw.rnsPort === null
        ? null
        : intField(raw.rnsPort, "rnsPort", 0, 1),
    propagationNode:
      raw.propagationNode === undefined || raw.propagationNode === null
        ? null
        : hashField(raw.propagationNode, "propagationNode"),
    syncIntervalSec: intField(raw.syncIntervalSec, "syncIntervalSec", 0),
    midRunBehavior,
    chunkChars: intField(raw.chunkChars, "chunkChars", 2500, 1),
    announceIntervalSec:
      raw.announceIntervalSec === undefined || raw.announceIntervalSec === null
        ? null
        : intField(raw.announceIntervalSec, "announceIntervalSec", 0, 60),
    configPath,
  };
}

// --- Machine-managed state ------------------------------------------------

/**
 * Reads a JSON state file, returning `null` when absent or corrupt.
 *
 * @param {string} path
 * @returns {Record<string, any>|null}
 */
function readStateFile(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes a JSON state file with `0600` permissions, creating directories.
 *
 * @param {string} path
 * @param {Record<string, any>} data
 */
function writeStateFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Loads the paired owner hash, if any.
 *
 * @param {string} dataDir
 * @returns {string|null} 32-hex owner hash, or null when not yet paired.
 */
export function readOwnerState(dataDir) {
  const state = readStateFile(join(dataDir, "owner"));
  const hash = state?.hash;
  return typeof hash === "string" && HEX32_RE.test(hash) ? hash : null;
}

/**
 * Persists the paired owner hash.
 *
 * @param {string} dataDir
 * @param {string} hash - 32-hex owner hash.
 */
export function writeOwnerState(dataDir, hash) {
  writeStateFile(join(dataDir, "owner"), {
    hash,
    pairedAt: new Date().toISOString(),
  });
}

/**
 * Loads the persisted Pi session pointer, if any.
 *
 * @param {string} dataDir
 * @returns {{sessionFile: string}|null}
 */
export function readSessionPointer(dataDir) {
  const state = readStateFile(join(dataDir, "session"));
  const sessionFile = state?.sessionFile;
  return typeof sessionFile === "string" && sessionFile
    ? { sessionFile }
    : null;
}

/**
 * Persists the Pi session pointer (the JSONL file `pi --session` resumes).
 *
 * @param {string} dataDir
 * @param {string} sessionFile - Absolute path to the session file.
 */
export function writeSessionPointer(dataDir, sessionFile) {
  writeStateFile(join(dataDir, "session"), { sessionFile });
}
