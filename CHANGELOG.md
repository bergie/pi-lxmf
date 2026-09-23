# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
    the daemon now logs every decrypted inbound packet with its source hash
    and whether the sender's identity is known — when it is unknown the
    router parks the message until an announce arrives, which is the most
    common reason a sender sees its packet acknowledged but the bridge
    never receives anything. Peer-announce learning is logged too, so a
    parked message can be correlated with the announce that released it.
    Ported from signalk-reticulum where this instrumentation proved out the
    identity-parking failure mode.
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
- GitHub Actions CI: tests (with lint and type checks) on every push, and
  OIDC-based npm publishing on tag pushes (no registry token stored).
