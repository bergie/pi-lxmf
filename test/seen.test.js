/**
 * Tests for the persistent LXMF message-id dedup (replay protection, work
 * doc #8): first-seen admission, replay rejection, restart persistence,
 * corruption tolerance, and pruning by age/count.
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadSeenState,
  pruneSeenState,
  recordSeenMessage,
  seenMessagesPath,
} from "../src/seen.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "pi-lxmf-seen-"));
}

test("recordSeenMessage admits an id once and rejects replays", () => {
  const dir = makeDataDir();
  try {
    assert.equal(
      recordSeenMessage(dir, "aa".repeat(16), { nowMs: 1000 }),
      true,
    );
    assert.equal(
      recordSeenMessage(dir, "aa".repeat(16), { nowMs: 2000 }),
      false,
    );
    assert.equal(
      recordSeenMessage(dir, "bb".repeat(16), { nowMs: 2000 }),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seen state persists across a simulated restart", () => {
  const dir = makeDataDir();
  try {
    recordSeenMessage(dir, "cc".repeat(16), { nowMs: 1000 });
    // A fresh call re-loads from disk (no in-memory cache to carry state).
    assert.equal(
      recordSeenMessage(dir, "cc".repeat(16), { nowMs: 2000 }),
      false,
    );
    const state = loadSeenState(dir);
    assert.equal(state.seen["cc".repeat(16)], 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state file is written with 0600 permissions", () => {
  const dir = makeDataDir();
  try {
    recordSeenMessage(dir, "dd".repeat(16), { nowMs: 1000 });
    const file = seenMessagesPath(dir);
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or corrupt state reads as empty and is rebuilt on write", () => {
  const dir = makeDataDir();
  try {
    assert.deepEqual(loadSeenState(dir), { version: 1, seen: {} });
    const file = seenMessagesPath(dir);
    writeFileSync(file, "{not json");
    assert.deepEqual(loadSeenState(dir), { version: 1, seen: {} });
    assert.equal(
      recordSeenMessage(dir, "ee".repeat(16), { nowMs: 1000 }),
      true,
    );
    assert.equal(loadSeenState(dir).seen["ee".repeat(16)], 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSeenState drops entries older than maxAge and evicts beyond maxEntries", () => {
  const aged = { a: 0, b: 1000, c: 2000 };
  // `a` is more than 1500ms old at now=2000.
  pruneSeenState(aged, 2000, 10, 1500);
  assert.deepEqual(Object.keys(aged).sort(), ["b", "c"]);
  const capped = { x: 1, y: 2, z: 3 };
  pruneSeenState(capped, 10, 1, DAY_MS);
  assert.deepEqual(Object.keys(capped), ["z"]);
});

test("recordSeenMessage prunes to the cap", () => {
  const dir = makeDataDir();
  try {
    for (let i = 0; i < 12; i++) {
      const id = i.toString(16).padStart(2, "0").repeat(16);
      assert.equal(
        recordSeenMessage(dir, id, { nowMs: i, maxEntries: 10 }),
        true,
      );
    }
    const state = loadSeenState(dir);
    // The two oldest were evicted; the newest ten remain.
    assert.equal(state.seen["00".repeat(16)], undefined);
    assert.equal(state.seen["01".repeat(16)], undefined);
    assert.equal(state.seen["0b".repeat(16)], 11);
    assert.equal(Object.keys(state.seen).length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
