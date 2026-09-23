# pi-lxmf

Drive the [Pi](https://pi.dev) coding agent **entirely from an LXMF messaging
client** — [Sideband](https://github.com/markqvist/Sideband),
[Nomad Network](https://github.com/markqvist/NomadNet), or any other
[LXMF](https://github.com/markqvist/LXMF) peer — over the
[Reticulum](https://reticulum.network) mesh. Built on
[reticulum-js](https://reticulum.js.org/).

`pi-lxmf` is a small daemon for headless servers: your chat messages become
prompts, finished assistant replies are delivered back as chat messages, and
the usual Pi controls (`/new`, `/compact`, `/abort`, model and thinking
switches) work from chat. Exactly one configured owner — identified by their
**Reticulum identity hash** — controls the agent; everyone else is ignored.
Architecture and internals: [SPEC.md](SPEC.md).

```text
Sideband / NomadNet ◄──LXMF──► pi-lxmf daemon ◄──RPC──► pi --mode rpc
                              (identity, announce,     (supervised child,
                               session)                 restartable)
```

## Requirements

- Node.js ≥ 20
- `pi` on `PATH`, logged into a provider
- A Reticulum transport: a local `rnsd` (recommended), or AutoInterface
  (IPv6 multicast), or an `rnsd` reachable over TCP

## Install

```bash
npm install -g pi-lxmf
# or from a checkout:
git clone … && cd pi-lxmf && npm install
node src/bin.js --help
```

## Quick start

1. **Configure** — create `~/.config/pi-lxmf/config.json` (override with
   `--config <path>` or `$PI_LXMF_CONFIG`) and `chmod 600` it:

   ```json
   {
     "name": "pi on myserver",
     "workdir": "/srv/myproject",
     "model": "anthropic/claude-sonnet-4-5",
     "owner": "<your Reticulum identity hash, 32 hex chars>"
   }
   ```

   `owner` is **required** and takes your **Reticulum identity hash** — the
   32-hex identifier of your Ed25519 identity, *not* the `lxmf.delivery`
   destination hash ("LXMF Address") your client displays. The identity hash
   is protocol-agnostic (the same you across LXMF, Nomadnet, …) and is what a
   future DACAR-style permission system would grant to; the daemon derives
   the wire form internally.

2. **Run the daemon** in the project directory (or set `workdir`):

   ```bash
   pi-lxmf
   ```

   The startup banner prints the node's identity and LXMF address:

   ```text
   pi-lxmf: pi on myserver starting
     identity   6bd23ddae42b6ab1b90ef1ce62a41f31
     lxmf       92b5be0e43370f01de77126b0eb11b53
     announce   pi on myserver
     owner (identity) 3f9dd04e9216c0a3b8c7e5f1d2a60b44
   pi-lxmf: ready — listening for LXMF messages
   ```

3. **Say hello** — in Sideband, start a conversation with the daemon's LXMF
   address (scan the announce or enter the hash manually) and send a message.
   Only the configured owner is answered; everyone else is dropped.

4. **Trust the project once** — Pi's project trust cannot be prompted over
   LXMF. Run `pi` interactively once in `workdir` (or preconfigure trust) so
   project-local `.pi` resources load in RPC mode.

## Chat commands

| You send | Action |
|---|---|
| plain text | a prompt to the agent (steered into a running turn by default) |
| `/help` | bridge commands + Pi commands available via prompt |
| `/status` | model, thinking, session, uptime, node + owner identity hashes |
| `/session` | message counts, tokens, cost, context usage |
| `/new` | fresh Pi session |
| `/name [name]` | show / set the session display name |
| `/compact [instructions]` | compact the conversation context |
| `/model [query]` | list models, or switch (`/model sonnet`) |
| `/think <level>` | set thinking level (`off`…`max`) |
| `/abort` | abort the run **and** drop queued messages |
| `!` | quick interrupt — abort only, queue intact |
| `/quit` | shut down the daemon and Pi |
| any other `/…` | passed to Pi (extension commands, `/skill:…`, templates) |

Replies are delivered per finished assistant message, chunked to fit
`chunkChars`. A run that ends without any reply triggers one recovery attempt,
then a `✅ done (no reply)` nudge. Extension dialogs raised inside Pi are
auto-declined (nobody is at a terminal) and reported to you.

## Configuration

`~/.config/pi-lxmf/config.json` (XDG env vars respected). A missing file runs
on defaults.

| Field | Default | Meaning |
|---|---|---|
| `owner` | *(required)* | the owner's 32-hex **Reticulum identity hash** (not the LXMF address); the daemon derives the `lxmf.delivery` destination hash for wire comparison |
| `name` | `pi-lxmf <version>` | announce display name |
| `workdir` | daemon cwd | project directory Pi runs in (also where `AGENTS.md` is found) |
| `model` | Pi default | `--model` pattern passed to Pi |
| `piBin` | `pi` | Pi binary |
| `dataDir` | `~/.local/share/pi-lxmf` | state root (see below) |
| `rnsHost` / `rnsPort` | — | rnsd TCP interface, used when no local shared instance is found |
| `propagationNode` | — | `lxmf.propagation` hash for outbound submits + optional sync |
| `syncIntervalSec` | `0` (off) | pull messages from the propagation node on this cadence |
| `midRunBehavior` | `steer` | how prompts arriving mid-run are delivered: `steer` or `followUp` |
| `chunkChars` | `2500` | max characters per outbound LXMF message |
| `announceIntervalSec` | router default | re-announce cadence |

### State (`dataDir`)

- `storage/` — the node's persistent Reticulum identity and caches. **This key
  is the node's address; back it up and keep it secret.** Deleting it changes
  your LXMF address.
- `session` — pointer to the current Pi session file. Sessions survive daemon
  restarts (`pi --session`); `/new` starts a fresh one.

### Mesh connectivity

The daemon attaches to a local `rnsd` shared instance when available (the
recommended setup — rnsd owns the radio/network interfaces), and otherwise
falls back to AutoInterface, optionally plus a TCP interface via
`rnsHost`/`rnsPort`. It announces itself periodically so peers can find it and
cached paths stay fresh.

If you configure a `propagationNode`, replies can be submitted for
store-and-forward delivery while you are unreachable, and `syncIntervalSec`
retrieves messages that arrived while the daemon was down.

## Security

- Inbound LXMF messages are **signature-verified by the router**; only
  messages from the configured owner's identity are processed (matched via
  the derived `lxmf.delivery` destination hash), everyone else is dropped
  silently — the daemon never answers strangers.
- The owner is **configured, never learned**: there is no first-contact
  pairing, so a stray message can never seize control.
- Access is keyed by **identity hash**, so it can later be delegated to a
  DACAR-style permission system without reconfiguration.
- The bridge never executes chat text locally — everything goes through Pi's
  RPC protocol. Approval-gated tools stay gated (dialogs are declined).
- `/quit` and full agent control are available to the owner only.

## Running as a service

Example systemd unit (adjust paths):

```ini
[Unit]
Description=pi-lxmf bridge
After=network-online.target rnsd.service

[Service]
ExecStart=/usr/bin/pi-lxmf --config /etc/pi-lxmf/config.json
Restart=on-failure
User=pi

[Install]
WantedBy=multi-user.target
```

The daemon supervises Pi itself: an unexpected Pi exit triggers a restart
(with the session resumed) and is reported to you over LXMF; a crash loop
gives up and says so.

## Development

```bash
npm test          # unit tests (node --test)
npm run types     # tsc --noEmit over the JSDoc-typed sources
npm run lint      # biome
npm run smoke     # end-to-end against a local rnsd: daemon + fake pi +
                  #   a second in-process LXMF node as the owner
```

## License

EUPL-1.2
