/**
 * @file identity.js
 *
 * Pure identity-hash helpers (node:crypto only, no @reticulum import, so the
 * bridge and its tests stay light).
 *
 * The daemon identifies people by their **Reticulum identity hash** — the
 * protocol-agnostic 32-hex identifier of an Ed25519 identity — rather than by
 * any single destination hash. One identity can host many destinations
 * (`lxmf.delivery`, `lxmf.propagation`, `nomadnetwork.node`, …), and
 * identity-keyed access maps directly onto future DACAR-style permission
 * management (../dacar grants are made to identities).
 *
 * On the wire, LXMF source/destination hashes are `lxmf.delivery` *destination*
 * hashes, so a configured identity hash is expanded via
 * {@link deriveLxmfDestinationHash} for comparison — the same derivation
 * @reticulum/core's `Destination` performs (`SHA256(nameHash ‖ identityHash)[:16]`,
 * `nameHash = SHA256(full_name)[:10]`), proven in `test/identity.test.js`
 * against the real `Destination.IN`.
 */

import { createHash } from "node:crypto";

/** Truncated hash length in bytes (SHA-256[:16]). */
const HASH_BYTES = 16;

/** The LXMF single-endpoint full name (app name + aspect). */
const LXMF_DELIVERY_APP_NAME = "lxmf.delivery";

/**
 * Decodes a 32-hex-char hash string to bytes.
 *
 * @param {string} hex
 * @returns {Uint8Array}
 * @throws {Error} on wrong length or non-hex input.
 */
function hashFromHex(hex) {
  const cleaned = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(cleaned)) {
    throw new Error(
      `Expected a 32-hex-character hash, got: ${JSON.stringify(hex)}`,
    );
  }
  return new Uint8Array(
    Array.from({ length: 16 }, (_, i) =>
      Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16),
    ),
  );
}

/**
 * Encodes bytes as lowercase hex.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function hashToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derives a destination hash for an identity and application name, matching
 * @reticulum/core's `Destination`: `SHA256(nameHash ‖ identityHash)[:16]`
 * where `nameHash = SHA256(full_name)[:10]`.
 *
 * @param {string} identityHashHex - The identity's 32-hex hash.
 * @param {string} appName - Full destination name (e.g. `"lxmf.delivery"`).
 * @returns {string} 32-hex destination hash.
 */
export function deriveDestinationHash(identityHashHex, appName) {
  const identityHash = hashFromHex(identityHashHex);
  const nameHash = createHash("sha256")
    .update(appName, "utf8")
    .digest()
    .subarray(0, 10);
  const combined = new Uint8Array(nameHash.length + identityHash.length);
  combined.set(nameHash, 0);
  combined.set(identityHash, nameHash.length);
  const digest = createHash("sha256").update(combined).digest();
  return hashToHex(digest.subarray(0, HASH_BYTES));
}

/**
 * Derives the `lxmf.delivery` destination hash (the "LXMF address" clients
 * display) for an identity hash — the wire form an identity-configured owner
 * is compared against.
 *
 * @param {string} identityHashHex
 * @returns {string} 32-hex `lxmf.delivery` destination hash.
 */
export function deriveLxmfDestinationHash(identityHashHex) {
  return deriveDestinationHash(identityHashHex, LXMF_DELIVERY_APP_NAME);
}
