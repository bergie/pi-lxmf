/**
 * Tests for the pure identity-hash helpers, cross-validated against
 * @reticulum/core's real `Destination` hash computation (so a configured
 * identity hash really expands to the wire form the router compares).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  Destination,
  DestType,
  Identity,
  Reticulum,
  toHex,
} from "@reticulum/core";
import {
  deriveDestinationHash,
  deriveLxmfDestinationHash,
} from "../src/identity.js";

test("derives the lxmf.delivery destination hash exactly like @reticulum/core", async () => {
  const rns = new Reticulum();
  const identity = await Identity.loadOrGenerate(null);
  const identityHash = toHex(identity.identityHash);

  const destination = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    rns,
  );

  assert.equal(
    deriveLxmfDestinationHash(identityHash),
    toHex(/** @type {Uint8Array} */ (destination.destinationHash)),
  );
});

test("derivation is stable and validates input", () => {
  const identityHash = "abcdef0123456789abcdef0123456789";
  assert.equal(
    deriveLxmfDestinationHash(identityHash),
    deriveLxmfDestinationHash(identityHash.toUpperCase()),
  );
  // Same identity under a different app name gives a different destination.
  assert.notEqual(
    deriveDestinationHash(identityHash, "lxmf.delivery"),
    deriveDestinationHash(identityHash, "nomadnetwork.node"),
  );
  assert.throws(() => deriveLxmfDestinationHash("nothex"), /32-hex/);
  assert.throws(() => deriveLxmfDestinationHash(""), /32-hex/);
});
