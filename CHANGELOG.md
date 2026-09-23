# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- z.ai GLM quota watcher + peak-hours warning (`src/quota.js`, work doc #3):
  when the active model is a z.ai GLM model (`provider === "zai"`), the
  bridge watches the z.ai quota endpoint (`pi-glm-usage`'s) and delivers
  exactly one LXMF message to the owner the moment the 5h quota bucket
  recovers after a quota-exhausted run failure. Also warns the owner at
  run start (and when the window opens mid-run) during z.ai peak hours
  (Mon–Fri 14:00–18:00 SGT / UTC+8, 3× token cost). Entirely gated on
  the active model being `zai` — nothing fires for Cortecs/Anthropic/etc.
  A missing `zai.key` disables the watcher gracefully.

### Fixed

- Pi session pointer is now scoped to the resolved `workdir` (work doc #4):
  pointers live at `dataDir/sessions/<sha256(workdir)[:16]>.json` so
  distinct repos keep distinct sessions. Previously the single
  `dataDir/session` file was shared across every repo, so starting the
  daemon in a different cwd resumed the previous repo's conversation.
  One-time migration: the legacy `dataDir/session` is adopted for the
  first workdir that reads it, then removed. Foundational to the
  multi-repo `/cd` work (doc #2).

- Initial implementation of the `pi-lxmf` bridge: an LXMF ↔ Pi RPC daemon per
  `SPEC.md`.
  - `PiRpcClient` (`src/rpc.js`): spawns and supervises `pi --mode rpc`,
    strict-JSONL framing (LF-only, `\r`-tolerant), id-correlated requests,
    readiness probing, crash-restart with backoff and a crash-loop guard.
  - Mesh side (`src/lxmf.js`): persistent Reticulum identity, shared-instance →
    AutoInterface → TCP interface fallback, `LXMRouter` with periodic
    announcing, optional propagation-node sync, chunked outbound delivery. A
    `skipSharedInstance` config option bypasses the local rnsd shared instance
    entirely in favour of own interfaces (AutoInterface + the `rnsHost`/
    `rnsPort` TCP client) — for shared instances that do not forward routed,
    multi-hop traffic to their local clients (observed on a Termux↔Columba
    setup where the daemon's announces reached the mesh but every inbound link
    request died at the rnsd, so senders never got delivery proofs). The
    startup banner now also lists the attached interfaces.
  - Bridge (`src/bridge.js`): owner-only access by configured Reticulum
    identity hash (no first-contact pairing; derivation cross-validated
    against @reticulum/core), serialized inbound pipeline, prompts (steer/follow-up mid-run), assistant
    reply delivery with empty-tail recovery, extension-dialog auto-dismissal.
  - Chat commands (`src/commands.js`): `/help`, `/status`, `/session`, `/new`,
    `/name`, `/compact`, `/model`, `/think`, `/abort`, `/quit`, and the bare
    `!` interrupt.
  - Configuration and state (`src/config.js`): XDG-based config file with the
    required `owner` identity hash, Pi session pointer persistence.
  - End-to-end smoketest (`scripts/smoke.mjs` + `scripts/fake-pi.mjs`): runs
    the real daemon against a fake `pi --mode rpc` and a second in-process
    LXMF owner over a local rnsd shared instance.
  - Inbound LXMF diagnostics (`attachInboundDiagnostics` in `src/lxmf.js`):
    surfaces the inbound failure mode the bridge itself can't see — a
    packet that decrypts but never dispatches. When the sender's identity
    is unknown the router parks the message until an announce arrives (the
    most common reason a sender sees its packet acknowledged but the bridge
    never receives anything), and that is now logged; unparseable packets
    are logged too. The peer-learn (`"peer"` event) log is filtered to the
    configured owner identity only — routine mesh peers are no longer
    logged.
    Successfully-dispatched owner traffic is intentionally silent here —
    the bridge logs its disposition (ignored / command / prompt) where the
    decision is made. Ported from signalk-reticulum where this
    instrumentation proved out the identity-parking failure mode.
  - Outbound reply fallback: a failed reply over the arrival link is now
    retried once more without the link (fresh DIRECT link, then
    opportunistic packet). Battery-conscious mobile clients tear their
    link down right after their own message is acknowledged, so the arrival
    link is frequently gone by reply time. The same `LXMessage` object is
    re-sent so every wire copy shares one message id and a deduplicating
    client (Sideband, NomadNet) renders the reply once.
  - Run-start acknowledgement via LXMF reaction: when a run starts and no
    reply lands within a 2 s debounce window, the bridge sends a 🤔
    reaction (LXMF `FIELD_REACTION`, §5.9.8) targeting the message that
    triggered the run, so the owner sees their message acknowledged while
    the agent works. A fast run whose reply beats the window sends no
    extra message. The reaction is carried solely by the reaction field
    (Sideband/NomadNet render it natively; no separate chat bubble is
    emitted alongside it). The internal empty-reply recovery run is never
    acknowledged. Added
    `sendReaction(destinationHex, targetMessageId, emoji, opts)` to the
    mesh adapter (`src/lxmf.js`), reusing the same retry path as
    `sendText`.
- Fixed bzip2 compression provider (`src/bz2.js`): the wasm `compress()`
  defaults its output buffer to the input length, so an LXMF reply that
  compressed worse than its input (incompressible / small / already-
  compressed data) threw `BZ_OUTBUFF_FULL` and failed delivery. The adapter
  now sizes the output buffer with bzip2's documented worst-case headroom
  (`input + 1% + 600` bytes).
- Security: the bridge now signature-verifies every inbound owner message
  itself, closing a gap on the propagation-sync path. The router verifies
  signatures on direct delivery, but a message pulled in via
  `syncFromPropagationNode` whose sender identity is not yet recalled is
  dispatched WITHOUT verification (mirroring Python's `SOURCE_UNKNOWN`
  handling) — and the bridge's owner-hash check alone is forgeable there
  (a 16-byte hash, no private key needed). The bridge now calls
  `verifySender(message)` on the mesh adapter (recalls the sender identity
  and checks the signature) and drops anything that isn't cryptographically
  proven, including `unknown` (parked) results, so a synced message is only
  admitted once the owner's identity has been learned. This makes the
  SPEC.md §11 / README "signature-verified" claim hold for every path.
- GitHub Actions CI: tests (with lint and type checks) on every push, and
  OIDC-based npm publishing on tag pushes (no registry token stored).
