/**
 * Smoketests for the bzip2 adapter: the compress/decompress round-trip and,
 * specifically, the output-buffer headroom that prevents BZ_OUTBUFF_FULL on
 * input that compresses worse than its length (incompressible / small data).
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createBz2 } from "../src/bz2.js";

test("compress/decompress round-trips plain text", async () => {
  const bz2 = await createBz2();
  const text = new TextEncoder().encode(
    "LXMF reply that should compress down to nearly nothing.",
  );
  const compressed = bz2.compress(text);
  const back = bz2.decompress(compressed, text.length);
  assert.deepEqual(Array.from(back), Array.from(text));
});

test("incompressible input (expands past length) does not throw", async () => {
  const bz2 = await createBz2();
  // Random bytes compress to ~input + 1% + 600: previously BZ_OUTBUFF_FULL.
  const data = randomBytes(4000);
  const compressed = bz2.compress(data);
  assert.ok(compressed.length > data.length, "expected expansion");
  const back = bz2.decompress(compressed, data.length);
  assert.deepEqual(Array.from(back), Array.from(data));
});

test("small input still round-trips", async () => {
  const bz2 = await createBz2();
  const data = new TextEncoder().encode("🤔");
  const compressed = bz2.compress(data);
  const back = bz2.decompress(compressed, data.length);
  assert.deepEqual(Array.from(back), Array.from(data));
});
