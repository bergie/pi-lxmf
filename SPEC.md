# pi-lxmf — Driving Pi over LXMF: Implementation Specification

## 1. Overview & objectives

`pi-lxmf` is a bridge that lets a human drive a [Pi](https://pi.dev) coding
agent running on a headless server entirely from an LXMF messaging client
(Sideband, Nomad Network, or any `@reticulum/lxmf` peer) over the Reticulum
Network Stack.

The design goal is the experience of
[pi-msg](https://github.com/zachpmanson/pi-msg) (which bridges Pi to XMPP):
chat messages become prompts, finished assistant replies are delivered back
as chat messages, and the usual Pi controls (`/new`, `/compact`, `/abort`,
model/thinking switches, session stats) work over chat without anyone at a
terminal. The LXMF side is built on [reticulum-js](https://reticulum.js.org/)
(`@reticulum/lxmf`), wire-compatible with the Python LXMF reference, so any
existing LXMF client can drive the agent with no server-side changes beyond
running one daemon.

Objectives, in priority order:

1. **Single owner, full control.** One configured owner — identified by
   their Reticulum identity hash — drives the agent; everyone else is
   ignored. Plain text is a prompt,
   slash commands map to Pi controls, and replies always reach the owner.
2. **Robust asynchronous operation.** LXMF is store-and-forward and mesh
   transport is slow and lossy; the bridge never assumes a fast round trip.
   Long replies are chunked, runs may take many minutes, and a restart
   resumes the previous Pi session.
3. **No terminal required.** Nothing in the operation of the bridge assumes
   a TUI. Extension dialogs raised inside Pi are auto-declined and reported
   over LXMF.
4. **Plain Node.js, small surface.** ESM JavaScript with JSDoc types,
   `node --test` tests, no build step — matching the conventions of
   `pi-rngit-work-document-skill` and the reticulum-js packages.

Non-goals for the initial version: group conversations (LXMF has no MUC),
file attachments in either direction, streaming/preview of in-flight turns,
and acting as an LXMF propagation node. These are covered in §13.

## 2. Prior art and reference material

| Reference | What is taken from it |
|---|---|
| [pi-msg](https://github.com/zachpmanson/pi-msg) | Overall architecture: a bridge daemon spawns `pi --mode rpc` and translates between chat and Pi's JSONL RPC protocol. Command surface (`/new`, `/abort` vs `!`, `/model`, `/session`, …), session persistence across restarts, empty-tail reply recovery, auto-dismissing extension dialogs. |
| [@llblab/pi-telegram](https://pi.dev/packages/@llblab/pi-telegram) | The JS/Pi-package conventions studied for this spec: config under the agent/home directory, queue-instead-of-interrupt handling of messages that arrive mid-run. (Its first-contact pairing was deliberately *not* adopted — see §6.1.) |
| `reticulum-js` (`@reticulum/core`, `@reticulum/lxmf`, `@reticulum/node`) | The entire LXMF transport: `LXMRouter`, `LXMessage`, interface setup (shared instance → AutoInterface → TCP fallback), announce app-data conventions, identity persistence. See `../reticulum-js/examples/lxmf_echobot.js` and `lxmf_sender.js` for the canonical wiring. |
| `pi-rngit-work-document-skill` | Project conventions: ESM + JSDoc, Biome with `--use-editorconfig=true`, `node --test`, EUPL-1.2, `@reticulum/*` dependency set, `createBz2()` adapter for Resource compression. |
| Pi RPC protocol (`docs/rpc.md` of `@earendil-works/pi-coding-agent`) | The exact command/event vocabulary used below. |

## 3. Architecture

```text
┌──────────────┐  LXMF (signed, encrypted,   ┌─────────────────────────────┐
│ Owner's      │  store-and-forward over     │ pi-lxmf bridge daemon       │
│ LXMF client  │  the Reticulum mesh)        │ (Node.js, this package)     │
│ (Sideband /  │ ◄─────────────────────────► │                             │
│  NomadNet)   │                             │  LXMRouter  ◄──┐            │
└──────────────┘                             │                │ spawn/JSONL│
                                             │  PiRpcClient ──┴── pi --mode rpc
                                             └─────────────────────────────┘
```

Two processes, deliberately:

- **The bridge daemon** (`pi-lxmf` bin) owns everything long-lived and
  precious: the Reticulum identity (the node's LXMF address), the mesh
  interfaces, the announce loop, and the session pointer.
  It must survive Pi crashes and Pi upgrades without changing identity.
- **`pi --mode rpc`** is a child process, disposable and restartable. All
  agent control flows through its documented RPC protocol (JSON commands on
  stdin, JSONL events on stdout), so the bridge depends only on Pi's stable
  RPC surface — not on extension-internal APIs.

### 3.1 Why not an in-process Pi extension

An earlier pi-msg revision ran the bridge as an in-process extension and was
rebuilt on RPC mode because `sendUserMessage` cannot reach Pi's command
layer; the same trade-off applies here. Additionally:

- RPC mode exits when its stdin closes, so a long-running headless
  deployment needs a supervisor holding the pipes anyway — the daemon *is*
  that supervisor, and putting the bridge logic there removes the
  indirection.
- Session lifecycle commands (`new_session`, `compact`, `set_model`,
  `export_html`, …) are first-class RPC commands, keeping the bridge out of
  the extension API churn.
- A Pi crash must not take the mesh identity down with it; the daemon
  restarts Pi and resumes the session file.

A small companion Pi extension remains a future option for agent-side
*tools* (e.g. proactive file sends, §13); it is not needed to drive the
agent.

## 4. Process management (PiRpcClient)

`src/rpc.js` implements `PiRpcClient`, a spawn-and-talk client for
`pi --mode rpc`:

- **Spawn:** `pi --mode rpc` with `cwd` = configured `workdir`, plus
  `--model <pattern>` when configured and `--session <file>` when a saved
  session pointer exists and the file is non-empty. The daemon's
  environment is inherited.
- **Framing:** Pi's RPC protocol is strict JSONL with `\n` as the only
  record delimiter. Node's `readline` is **not** protocol-compliant (it
  also splits on U+2028/U+2029, which are valid inside JSON strings), so
  `rpc.js` implements its own line reader: a `StringDecoder`-backed buffer
  split on `\n`, tolerating a trailing `\r`. The same reader is reused for
  stderr logging.
- **Correlation:** every command is sent with a generated `id`; `response`
  events are matched by `id` and resolve a pending promise (with timeout).
  Non-response events are forwarded to the bridge through an `onEvent`
  callback. Lines are bounded (8 MiB) since assistant/tool payloads can be
  large.
- **Readiness:** RPC mode accepts commands once its stdin reader is
  attached; the daemon probes with `get_state` (retries with backoff,
  ~10 s budget) before considering Pi ready.
- **Streaming state:** the daemon tracks `agent_start` / `agent_settled`
  (plus `compaction_*`, `auto_retry_*`) to maintain a *busy* hint, but
  treats `get_state` → `isStreaming` as authoritative before every prompt
  (see §6.2).
- **Restart:** if Pi exits unintentionally (not a `/quit`), the daemon
  respawns it after a short backoff, re-applies `--session` from the last
  persisted pointer, and notifies the owner over LXMF. Repeated crashes
  (e.g. 3 within a minute) stop the respawn loop and report to the owner.
- **Shutdown:** SIGINT/SIGTERM or `/quit` → best-effort `get_state` to
  persist the session pointer, SIGINT to Pi (hard kill after 3 s), stop
  announcing, exit.

## 5. LXMF subsystem

`src/lxmf.js` owns the mesh side, wired like the reticulum-js `lxmf_echobot`
example:

1. **Storage & identity.** A `FileStorageAdapter` rooted at
   `<dataDir>/storage` persists the Ed25519 identity (and known
   destinations/ratchets) across restarts. `Identity.loadOrGenerate` loads
   or creates it. This identity *is* the node's stable LXMF address.
2. **Compression.** A `createBz2()` adapter (bzip2-wasm, as in
   `pi-rngit-work-document-skill`) is installed as the Reticulum
   `compressionProvider` so oversized replies transferred as §10 Resources
   are compressed.
3. **Interfaces.** Prefer `LocalClientInterface.connectToSharedInstance()`
   (attach to a running `rnsd`, which owns the real mesh interfaces). When
   no shared instance is reachable, fall back to `AutoInterface`, plus a
   `TCPClientInterface` when `rnsHost`/`rnsPort` are configured.
4. **Router.** `new LXMRouter(identity, rns)` + `await lxmf.init()`
   registers the `lxmf.delivery` destination (with forward-secrecy
   ratchets, per the router's own init).
5. **Announcing.** `startAnnouncing(name)` with `name` from config
   (default `pi-lxmf <version>`) fires an immediate announce and re-announces
   on the default cadence so cached mesh paths stay fresh; the §4.3
   msgpack app-data makes Sideband display the name.
6. **Receiving.** `message` events carry a signature-verified `LXMessage`
   (`detail.message`) and the link id (`detail.link`). The router already
   deduplicates by LXMF message id within a process lifetime. Note: the
   router only verifies signatures on the direct-delivery path — a message
   pulled in via propagation sync (step 8) whose sender identity is not yet
   recalled is dispatched unverified, so the bridge re-verifies every
   inbound owner message itself (see §11).
7. **Sending.** Replies are `LXMessage`s from our `deliveryDest` to the
   owner's LXMF address (their `lxmf.delivery` destination hash), sent with
   `lxmf.send(reply, identity, link)` — reusing the inbound link when one
   exists. The router handles direct-link
   delivery (Resources for bodies over the link MDU) and falls back to
   opportunistic delivery when no link can be established.
8. **Propagation (optional).** When `propagationNode` is configured (an
   `lxmf.propagation` destination hash), it is set as the outbound node
   (`setOutboundPropagationNode`) and, when `syncIntervalSec` > 0, the
   daemon periodically calls `syncFromPropagationNode(identity)` so
   messages that arrived while the daemon was down are still delivered.

### 5.1 Outbound message shape

- **Title:** the current session display name (from `get_state`), else the
  configured announce name — only on the first chunk of a reply.
- **Chunking:** content longer than `chunkChars` (default 2500) is split on
  paragraph boundaries where possible, each chunk suffixed
  `[… n/N]` except the last. Chunking keeps single LXMF messages
  reasonable for phone UIs and for mesh airtime.
- **Errors:** failures to deliver a reply are logged and retried once;
  persistent failure is reported in the next successful message (LXMF has
  no channel over which to report its own failure).

## 6. Bridge semantics

`src/bridge.js` connects the two subsystems. All inbound LXMF handling is
serialized through a single promise chain so prompts keep their order.

### 6.1 Owner model

- The controlling owner is **configured, never learned**: the required
  `owner` config field holds their **Reticulum identity hash** (32 hex) —
  the protocol-agnostic identifier of their Ed25519 identity, not the
  `lxmf.delivery` destination hash ("LXMF Address") the wire carries. The
  identity → destination-hash derivation (`src/identity.js`, proven against
  `Destination.IN` in tests) expands it to the wire form, and inbound
  messages whose LXMF source hash differs are dropped (logged at debug). No
  reply is sent to non-owners — the bridge must not acknowledge its existence
  to strangers.
- Rationale: one identity can host many destinations (`lxmf.delivery`,
  `nomadnetwork.node`, propagation nodes, …), so identity-keyed access is
  stable across protocols and maps directly onto future DACAR-based
  permission management (§13) — grants are made to identities. The same
  lesson was learned in `../signalk-reticulum`, which migrated crew entries
  from destination hashes to identity hashes.
- There is deliberately **no first-contact pairing**: a stray message can
  never seize control.

### 6.2 Inbound pipeline

For each accepted message:

1. Strip whitespace; ignore empty content.
2. If the text is a **bridge command** (§7), execute it locally — these
   never reach the LLM.
3. Otherwise the text is a **prompt**: query `get_state` for authoritative
   `isStreaming`, then send a `prompt` RPC command (opening the reply
   exchange optimistically, before the write):
   - idle → `{"type":"prompt","message":…}` (no `streamingBehavior`);
   - streaming → `streamingBehavior` from `midRunBehavior` config
     (`"steer"` default, matching pi-msg: mid-run chat messages are
     injected at the next yield point; `"followUp"` queues them instead).
   - If Pi rejects the prompt because a run started in between, retry once
     with `streamingBehavior` set; a final rejection closes the exchange
     again and is reported to the owner.
   - Slash-prefixed text that is *not* a bridge command is passed through
     unchanged: Pi's `prompt` dispatches extension commands immediately
     (even mid-run) and expands `/skill:…` and prompt templates itself.
     Unknown `/…` text simply becomes a prompt, as in pi-msg.
4. Increment the *pending reply* counter and, on success, remember the
   message's link id as the preferred reply channel.

### 6.3 Reply delivery

- `message_end` events with `role === "assistant"` are delivered as their
  own LXMF message whenever an LXMF-triggered exchange is active — pi-msg's
  model. Delivering each finalized message (rather than only the last one at
  settle time) means intermediate replies are never lost when several owner
  messages were queued mid-run; commentary blocks that precede tool calls
  also give the owner progress visibility on a channel where nothing else
  would. An exchange is opened **optimistically at prompt-write time**: pi can
  emit the acceptance response and the run's events in the same stdout
  chunk, and the response promise only resolves on a later microtask, so
  events handled in between must already count towards the exchange (a race
  proven by the smoketest's fake pi, which answers in a single chunk).
- On `agent_settled` the exchange closes; if nothing at all was delivered
  for it:
  - a recorded run failure (`auto_retry_end`/`compaction_end` error) is
    reported as `⚠️ run failed: …`;
  - otherwise **empty-tail recovery** runs once per exchange: a `prompt`
    asking the agent to write the reply it never wrote (a run that ends on a
    tool call produced no text; pi-msg's "empty-tail recovery"), opened with
    the same optimistic exchange semantics; if that recovery run *also*
    settles without text, the `✅ done (no reply) — your turn` nudge is sent
    instead of looping.
- Retries, compaction, and queued follow-ups all precede `agent_settled`,
  so the no-reply nudge only fires after Pi truly stops.
- Runs not triggered by LXMF (there is no local user in the intended
  deployment, but scheduled extensions could start runs) do not open an
  exchange; their output is not mirrored to the owner in v1.

### 6.4 Extension UI requests

`extension_ui_request` events (`select`/`confirm`/`input`/`editor`) are
answered with `{"type":"extension_ui_response","id":…,"cancelled":true}`
(nobody is at a TUI; approval-gated tools are declined over the bridge),
and the owner is informed: `⛔ dialog dismissed: <title>`. Fire-and-forget
UI methods (`notify`, `setStatus`, `setWidget`, …) are ignored.

### 6.5 z.ai GLM quota watcher and peak-hours warning

When the active model is a z.ai GLM model (`provider === "zai"`), the bridge
runs a `GlmQuotaWatcher` (`src/quota.js`) that does two things, both gated
on the active model being GLM — nothing fires for non-z.ai providers (e.g.
Cortecs, Anthropic):

- **Quota-recovery notification.** When a run fails with a z.ai
  quota-exhausted error (matched from `auto_retry_end`/`compaction_end`
  error messages), the watcher polls the same z.ai quota endpoint
  `pi-glm-usage` uses (`https://api.z.ai/api/monitor/usage/quota/limit`,
  Bearer `~/.pi/agent/auth.json` → `zai.key`, honouring `PI_AUTH_DIR`) every
  60s and delivers **exactly one** LXMF message to the owner the moment
  the 5h bucket drops below 100%. One notification per exhausted episode;
  rate-limit-only errors (transient, retried by Pi) do not arm it. A
  missing `zai.key` disables the watcher gracefully (logged once).
- **Peak-hours warning.** z.ai charges 3× tokens Mon–Fri 14:00–18:00
  Singapore Standard Time (UTC+8). The owner is warned when an
  owner-triggered run starts inside that window, and when the window
  opens mid-run, so they can decide whether to stop or continue. The
  internal empty-reply recovery run is never warned.

Notifications and warnings go to the configured `owner`; under future
DACAR per-subtree identity ACLs (§13) the "who to notify" decision stays
in one place so it can be retargeted per subtree.

## 7. Chat command reference

| Owner sends | Action | LLM turn |
|---|---|---|
| plain text | `prompt` (steered/queued mid-run per config) | yes |
| `/help` | list bridge commands and available Pi commands (`get_commands`) | no |
| `/status` | model, thinking level, busy state, session name/file, bridge uptime, node identity hashes | no |
| `/session` | `get_session_stats` — message counts, tokens, cost, context usage | no |
| `/new` | `new_session`, persist the new session pointer | no |
| `/name [name]` | `set_session_name`, or show current name | no |
| `/compact [instructions]` | `compact` (custom instructions appended) | summarizer only |
| `/model [query]` | no arg: list models (`get_available_models`, current marked); with arg: fuzzy-match `provider/id` or name, then `set_model` | no |
| `/think <level>` | `set_thinking_level` | no |
| `/abort` (or `/stop`) | `clear_queue` (tolerated if unknown) then `abort`; reports how many queued messages were dropped | no |
| `!` (bare) | `abort` only — quick interrupt, queue intact | no |
| `/quit` | graceful bridge shutdown (Pi and daemon) | no |
| any other `/…` | passed to Pi `prompt` (extension commands, `/skill:…`, templates) | maybe |

Command parsing: first whitespace-separated token, case-insensitive,
leading `!` equivalent to `/` for bridge commands (a bare `!` is the
interrupt). Commands are recognized only from the owner.

## 8. Configuration and state

**Config file** — first of: `--config <path>` flag, `$PI_LXMF_CONFIG`,
`$XDG_CONFIG_HOME/pi-lxmf/config.json`, `~/.config/pi-lxmf/config.json`.
JSON, `0600`, unknown keys rejected with a warning.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `owner` | string | *(required)* | the owner's 32-hex **Reticulum identity hash** (not the LXMF address); expanded to the `lxmf.delivery` destination hash for wire comparison |
| `name` | string | `pi-lxmf <version>` | announce display name |
| `workdir` | string | daemon cwd | project directory Pi runs in (also where Pi discovers `AGENTS.md`) |
| `model` | string | Pi default | `--model` pattern passed to Pi |
| `piBin` | string | `pi` | Pi binary |
| `dataDir` | string | `$XDG_DATA_HOME/pi-lxmf` (`~/.local/share/pi-lxmf`) | state root (see below) |
| `rnsHost` / `rnsPort` | string / number | — | rnsd TCP interface, used only when no shared instance is found |
| `propagationNode` | string | — | `lxmf.propagation` hash for outbound submits + optional sync |
| `syncIntervalSec` | number | `0` (off) | propagation sync cadence |
| `midRunBehavior` | `"steer"` \| `"followUp"` | `"steer"` | `streamingBehavior` for prompts arriving mid-run |
| `chunkChars` | number | `2500` | max characters per outbound LXMF message |
| `announceIntervalSec` | number | router default | re-announce cadence |

**State files** under `dataDir` (machine-managed, never hand-edited):

- `storage/` — Reticulum persistence (identity, known destinations,
  ratchets) via `FileStorageAdapter`.
- `sessions/<key>.json` — per-workdir Pi session pointers
  (`{ "sessionFile": … }`), keyed by the first 16 hex chars of
  `SHA-256(workdir)` so distinct repos keep distinct sessions (the session
  is the conversation; switching models mid-session keeps the same pointer).
  Written on `new_session`, on graceful shutdown, and whenever
  `get_state` observes a change. On daemon start the pointer for the
  current `workdir` is passed as `--session` if it still exists (a
  missing/empty pointer starts a fresh session). One-time migration: a
  pre-scoping legacy `session` file is adopted for the first workdir that
  reads it, then removed, so the adoption runs exactly once.

**Operational note:** Pi's project trust is not prompted for over LXMF.
Operators run Pi interactively once in `workdir` (or preconfigure trust) so
project-local `.pi` resources load in RPC mode.

## 9. Package layout

```text
pi-lxmf/
├── package.json          # name pi-lxmf, type module, bin { "pi-lxmf": "src/bin.js" }
├── CHANGELOG.md          # Keep a Changelog format, Unreleased segment
├── src/
│   ├── bin.js            # CLI: flags (--config, --version), config load, daemon loop, signals
│   ├── config.js         # load/merge/validate config; XDG paths; session-pointer persistence
│   ├── identity.js       # identity-hash → destination-hash derivation (DACAR-ready owner keying)
│   ├── rpc.js            # PiRpcClient: spawn, JSONL framing, id correlation, typed command helpers, restart
│   ├── lxmf.js           # mesh side: storage, identity, interfaces, router, announce, send (chunking), sync
│   ├── bridge.js         # inbound pipeline, command dispatch, reply delivery, empty-tail recovery, dialogs
│   ├── commands.js       # command table: parse + implementations as pure-ish functions over (rpc, ctx)
│   ├── text.js           # chunking + formatting helpers (dependency-free)
│   └── bz2.js            # bzip2-wasm adapter (as in pi-rngit-work-document-skill)
├── scripts/
│   ├── fake-pi.mjs       # minimal `pi --mode rpc` stand-in for the smoketest
│   └── smoke.mjs         # end-to-end smoketest against a local rnsd (below)
└── test/                 # node --test, see §12
```

Dependencies (runtime): `@reticulum/core`, `@reticulum/lxmf`,
`@reticulum/node` (all `^0.9.0`), `@digitaldefiance/bzip2-wasm` — the same
set `pi-rngit-work-document-skill` uses. Node ≥ 20. License EUPL-1.2.
`rngit: rns://adafb3153efd4d96d532568a5208b3b5/reticulum/pi-lxmf` once the
repository exists on the node.

## 10. Logging and diagnostics

- Daemon logs to stderr: startup banner (identity hash, delivery
  destination hash, interfaces, workdir, paired owner), Pi lifecycle
  events, LXMF send/receive summaries (hashes and sizes, never full
  bodies), errors.
- `PI_LXMF_DEBUG=1` enables Pi's stderr forwarding and RPC event tracing.
- The startup banner doubles as the setup script: it prints the exact
  LXMF address the owner should configure/expect.

## 11. Security model

- **Owner-only control, configured not learned.** Exactly one Reticulum
  identity (configured by identity hash; see §6.1) can drive the agent.
  The bridge signature-verifies every inbound owner message itself before
  processing (`mesh.verifySender`, recalling the sender identity and
  checking the LXMF signature). This is necessary because the router only
  verifies signatures on the direct-delivery path: a message pulled in via
  propagation-node sync whose sender identity is not yet recalled is
  dispatched without verification, and the owner source-hash check alone is
  forgeable on that path (a 16-byte hash, no private key needed). An
  unverified message — including one whose sender identity is unknown
  ("parked") — is dropped; a re-sync after the owner's announce lands will
  re-deliver it. There is no first-contact pairing: a stray message can
  never seize control, and the daemon never answers strangers. Identity-
  keyed access is ready for delegation to DACAR-based permission management
  (§13) without reconfiguration.
- **No shell surface.** The bridge never executes chat text locally; only
  Pi's RPC commands are used. The agent's own tool use is governed by Pi's
  normal permissions, not relaxed by the bridge. Declined dialogs mean
  approval-gated tools stay gated.
- **Key hygiene.** The Reticulum identity key is the root of the node's
  identity; `dataDir` must be backed up and treated as secret
  (`FileStorageAdapter` writes `0600`).
- **Unauthenticated replies are impossible** (outbound messages are signed
  by our identity); non-owner inbound is dropped silently.

## 12. Testing strategy

`node --test`, no network, no mesh:

- `config.test.js` — defaults, XDG env overrides, merge precedence,
  validation errors, and session-pointer persistence round-trips.
- `rpc.test.js` — the JSONL reader (chunked multi-byte UTF-8, `\r\n`
  tolerance, U+2028 inside strings must *not* split a record), and
  request/response correlation against a fake child stream.
- `identity.test.js` — the identity → destination-hash derivation,
  cross-validated against @reticulum/core's `Destination.IN` (so a configured
  identity hash really expands to the wire form the router compares).
- `commands.test.js` — command parsing (`/x`, `!`, bare `!`, case,
  args), model fuzzy matching over a fixture model list, command routing
  (bridge command vs passthrough prompt).
- `bridge.test.js` — smoketests of the full loop with a fake `PiRpcClient`
  and a fake LXMF sender: prompt→reply delivery, mid-run steering choice,
  empty-tail recovery then nudge, `/new` + session pointer update,
  dialog auto-dismiss, non-owner drop (by derived destination hash),
  chunking.

Mesh-level behaviour is exercised end-to-end by `scripts/smoke.mjs` (`npm
run smoke`), which needs a local rnsd shared instance: it spawns the real
daemon against a fake `pi --mode rpc` child, pairs a second in-process LXMF
node as the owner (admitted via a preconfigured identity hash, exercising
the derivation end-to-end), and verifies a prompt round-trip, `/help`, and
reply chunking — all over real LXMF. Announce visibility against Sideband on
an actual mesh is the remaining manual step.

## 13. Future work

- **File attachments** both ways: LXMF `fields` file attachments for
  inbound images into Pi prompts, and a `send_file` companion extension
  tool for outbound artifacts (pi-msg's XEP-0363 analogue).
- **Durable inbound journal** (pi-msg's inbox): persist inbound messages
  before handing them to Pi and replay unacknowledged ones after a crash,
  for exactly-once-ish delivery on top of LXMF's at-least-once.
- **Proactive notifications:** mirror locally-started runs' output to the
  owner (pi-telegram's "connected companion projection").
- **DACAR-based permissions** (../dacar): replace the single `owner`
  identity with grants/revocations synced over the mesh, keyed by identity
  hash as v1 already is.
- **Multiple owners.**
- **`/export` → LXMF attachment** of the rendered HTML session.
- **Propagation-node role** for the bridge itself, serving its owner's
  messages while the daemon is down.
