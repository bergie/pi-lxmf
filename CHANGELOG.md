# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Quota exhaustion and 90% warnings** (work doc #3): the GLM quota
  watcher now samples the z.ai quota API continuously while a GLM model
  is active (not just after a run fails) and notifies the owner when a
  bucket (5h or weekly) hits 100% — including at startup, when the daemon
  starts mid-outage — and when one crosses 90%. The startup check runs
  immediately on enable, so no error is needed to detect an exhausted
  bucket.
- The startup notification now names the active model (fresh `get_state`
  observation) — the model isn't visible anywhere else over LXMF.
- `/model` and `/think` re-observe state right away, so the quota watcher
  gate follows the switch immediately instead of on the next prompt.

### Fixed

- A run that failed after delivering partial output silently trailed
  off: the error is now reported as a "run ended early" message and no
  longer leaks into a later exchange's failure reply.

## [0.1.3] - 2026-09-27

### Changed

- The successful `/cd` reply is now a visually distinct banner (divider
  line, 📂/🔁/✨ emoji) so project change boundaries are easy to spot when
  scrolling back through the message history.

### Fixed

- Startup notification lost to the announce race: reticulum-js keeps the
  destination→identity mapping in memory, so right after a daemon restart
  the owner's `lxmf.delivery` hash is unknown and the router fails the
  "🟢 ready" send instantly (its path request only happens once the
  identity is known). `sendWithRetry` now recognises that failure, sends a
  path request (which solicits an announce from the peer or a node holding
  its path) and waits up to 30s for the announce before retrying — instead
  of burning two hopeless immediate retries and parking the text in the
  next reply's delivery-failure note.
- Configured propagation node was never used for outbound: reticulum-js's
  `lxmf.send` never consults the outbound propagation node on its own
  (unlike Python's `LXMRouter`), so despite `setOutboundPropagationNode`
  being called, replies to an off-mesh owner were simply lost. The retry
  chain now escalates to `submitToPropagationNode` (store-and-forward,
  delivered on the owner's next sync) after direct and opportunistic
  delivery both fail — including waiting for the node's own announce on a
  fresh start. The chain lives in the exported `createRetrySender`
  (unit-tested against a fake router) instead of a closure inside
  `startLxmf`.

## [0.1.2] - 2026-09-27

### Added

- Multi-repo support via `/cd` (work doc #2): one bridge can serve every
  repo under the daemon's start folder. `/cd <path>` switches the
  supervised Pi at runtime through a deliberate supervised respawn in the
  new cwd (no backoff, no crash-loop counting; `--model` carried across,
  the target repo's per-workdir session pointer applied via `--session`, so
  revisiting a repo resumes its conversation and a new repo starts fresh).
  Mid-run switches close the open exchange without empty-tail recovery.
  Boundary: only paths that resolve under the daemon `workdir` — the
  trust root — are accepted (`..` traversal, outside absolute paths,
  missing or non-directory targets are refused without touching the child);
  `resolveCwdTarget` in `src/commands.js` is the single choke point, kept
  ready for future DACAR per-subtree identity checks. The active cwd is
  persisted (`dataDir/cwd.json`) and revalidated at startup so restarts
  resume in the last repo. `/cd` without arguments lists the current and
  recently used repos (per-workdir session pointers now record their
  workdir), and `/status` shows the current `cwd` and `workdir`.

## [0.1.1] - 2026-09-24

### Added

- Startup notification to the owner (work doc #5): once the daemon is
  fully available (LXMF destination announcing, `pi --mode rpc` ready), it
  sends `🟢 pi-lxmf ready — listening for messages.` to the configured
  owner — plus a `Resuming session <file>.` line when a session pointer
  was resumed. Best-effort: a failed delivery is noted and carried by the
  next successful reply.

## [0.1.0] - 2026-09-24

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
