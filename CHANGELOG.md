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
    announcing, optional propagation-node sync, chunked outbound delivery.
  - Bridge (`src/bridge.js`): owner-only access with first-contact pairing,
    serialized inbound pipeline, prompts (steer/follow-up mid-run), assistant
    reply delivery with empty-tail recovery, extension-dialog auto-dismissal.
  - Chat commands (`src/commands.js`): `/help`, `/status`, `/session`, `/new`,
    `/name`, `/compact`, `/model`, `/think`, `/abort`, `/quit`, and the bare
    `!` interrupt.
  - Configuration and state (`src/config.js`): XDG-based config file, owner
    pairing state, Pi session pointer persistence.
  - End-to-end smoketest (`scripts/smoke.mjs` + `scripts/fake-pi.mjs`): runs
    the real daemon against a fake `pi --mode rpc` and a second in-process
    LXMF owner over a local rnsd shared instance.
- GitHub Actions CI: tests (with lint and type checks) on every push, and
  OIDC-based npm publishing on tag pushes (no registry token stored).
