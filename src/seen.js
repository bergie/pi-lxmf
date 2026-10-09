/**
 * @file seen.js
 *
 * Persistent LXMF message-id dedup (work doc #8, audit finding 1).
 *
 * The router's message-id dedup is in-memory only, so after a daemon
 * restart a replayed owner message — a propagation node re-serving old
 * messages, a duplicate redelivery, or a malicious on-mesh replay of a
 * captured packet — is signature-valid and would be re-executed: a full
 * LLM run (token burn) for output the owner already received, or worse a
 * replayed `/quit`. This module persists the ids of admitted messages in a
 * bounded, pruned set under `dataDir` so each message is processed at most
 * once across restarts.
 *
 * At-most-once, deliberately: the bridge records an id *before* running
 * the prompt. A crash mid-run then loses the message instead of re-running
 * it after restart — a lost message is recoverable (the owner resends), a
 * spent token budget is not.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** State file under `dataDir`. */
const SEEN_FILE = "seen-messages.json";

/** Default cap on stored ids (oldest evicted beyond this). */
const DEFAULT_MAX_ENTRIES = 1000;

/** Default age after which an id is pruned (its replay window has passed). */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The persisted seen-message state.
 *
 * @typedef {object} SeenState
 * @property {number} version
 * @property {Record<string, number>} seen - Message-id hex → first-seen epoch ms.
 */

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function seenMessagesPath(dataDir) {
  return join(dataDir, SEEN_FILE);
}

/**
 * Loads the seen-message state, tolerating absence and corruption (both
 * read as "nothing seen yet"; the next write rebuilds the file).
 *
 * @param {string} dataDir
 * @returns {SeenState}
 */
export function loadSeenState(dataDir) {
  const file = seenMessagesPath(dataDir);
  if (!existsSync(file)) return { version: 1, seen: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.seen !== "object" ||
      parsed.seen === null
    ) {
      return { version: 1, seen: {} };
    }
    /** @type {Record<string, number>} */
    const seen = {};
    for (const [id, ts] of Object.entries(parsed.seen)) {
      if (typeof ts === "number" && Number.isFinite(ts)) seen[id] = ts;
    }
    return { version: 1, seen };
  } catch {
    return { version: 1, seen: {} };
  }
}

/**
 * Prunes the seen set: drops entries older than `maxAgeMs`, then evicts the
 * oldest entries beyond `maxEntries`.
 *
 * @param {Record<string, number>} seen - Mutated in place.
 * @param {number} nowMs
 * @param {number} maxEntries
 * @param {number} maxAgeMs
 */
export function pruneSeenState(seen, nowMs, maxEntries, maxAgeMs) {
  for (const [id, ts] of Object.entries(seen)) {
    if (nowMs - ts > maxAgeMs) delete seen[id];
  }
  const entries = Object.entries(seen).sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < entries.length - maxEntries; i++) {
    delete seen[entries[i][0]];
  }
}

/**
 * Checks and records one LXMF message id: returns `true` the first time the
 * id is seen (the caller should process it), `false` on a replay (the
 * caller must drop it). The updated state is persisted (mode `0600`) before
 * returning, so a crash right after admission still counts the message as
 * seen.
 *
 * @param {string} dataDir
 * @param {string} idHex - Lowercase hex of the message's `message_id`.
 * @param {object} [options]
 * @param {number} [options.nowMs] - Injectable clock (tests).
 * @param {number} [options.maxEntries] - Cap on stored ids (tests).
 * @param {number} [options.maxAgeMs] - Age after which ids are pruned (tests).
 * @returns {boolean} `true` when the id is new and was recorded.
 */
export function recordSeenMessage(dataDir, idHex, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const state = loadSeenState(dataDir);
  if (Object.hasOwn(state.seen, idHex)) return false;
  state.seen[idHex] = nowMs;
  pruneSeenState(state.seen, nowMs, maxEntries, maxAgeMs);
  const file = seenMessagesPath(dataDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return true;
}
