/**
 * @file bz2.js
 *
 * Adapts `@digitaldefiance/bzip2-wasm` to the @reticulum/core `Bzip2`
 * interface (`{ compress, decompress }`) that `Reticulum` expects as its
 * `compressionProvider` (and `Link`/`Resource` as their `bz2` field) for
 * §10 Resource compression.
 *
 * Outbound LXMF bodies larger than the link MDU travel as Resources; without
 * a bz2 provider they go uncompressed, which is wasteful on slow mesh links.
 */

import BZip2 from "@digitaldefiance/bzip2-wasm";

/**
 * Creates and initialises a @reticulum/core-compatible bz2 adapter.
 *
 * `BZip2.init()` loads the WASM module, so this is async and must complete
 * before any Resource transfer.
 *
 * @returns {Promise<{compress: (data: Uint8Array) => Uint8Array, decompress: (data: Uint8Array, outputLen: number) => Uint8Array}>}
 */
export async function createBz2() {
  const bz = new BZip2();
  await bz.init();
  return {
    /**
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    compress: (data) => {
      // bzip2's worst-case expansion for incompressible / small / already-
      // compressed input is input + 1% + 600 bytes (bzip2 docs, `BZ2_bzBuff
      // ToBuffCompress`). The wasm `compress()` defaults its output buffer
      // to `data.length`, so without headroom a reply that compresses worse
      // than its input throws BZ_OUTBUFF_FULL and the whole send fails.
      const outLen = data.length + Math.floor(data.length / 100) + 600;
      return bz.compress(data, 5, outLen);
    },
    /**
     * @param {Uint8Array} data
     * @param {number} outputLen - Expected uncompressed length (from the adv).
     */
    decompress: (data, outputLen) => bz.decompress(data, outputLen),
  };
}
