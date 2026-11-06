# bs

Self-hosted sync for browser bookmarks and passwords. A single Go binary
(`bs`) stores append-only operation logs, and a browser extension syncs
Chrome and Firefox against it. Data is end-to-end encrypted.

### Features

- Bookmark sync: the full bookmark tree under the toolbar and other-bookmarks
  roots mirrors across machines. Create, delete, rename and move all propagate.
- Password sync: login, credit card and identity entries, kept in one vault.
- Save prompt: submitting a login or sign-up form asks to save the credential,
  or to update it when the password changed. A site can be muted with
  never-save; the list syncs across machines and is managed on the settings
  page.
- Autofill: click a login, card or identity field and candidates appear below
  the input. Works inside cross-origin iframes. Keyboard navigation included.
- TOTP: a stored one-time-password secret renders a current code on fill and
  copies it to the clipboard.
- Import: bookmarks from a browser HTML export, passwords from a Chrome or
  Firefox CSV export. Import replaces the log and rebuilds everywhere.

### Setup

1. Open the extension settings.
2. Enter the server address, for example `http://192.168.100.1:8000`.
3. Enter a master password. On the first machine, also paste the config token
   from the server terminal. Later machines skip the token.
4. Click save. The address and master password lock once connected; use reset
   to change them.

The master password must be identical on every machine. It derives the
encryption key, so a different password cannot read the same data.

## Transport

`bs` serves plain HTTP, so there is no domain, certificate authority, or
renewal to manage.

Run it inside a Zero Trust overlay network, which encrypts traffic and
authenticates machines:

- **[Tailscale](https://tailscale.com)** — WireGuard-based mesh VPN.
- **[nz](https://github.com/zyoung11/nz)** — my personal overlay network.

Then point the extension at the overlay address. 

## How it works

The extension watches bookmark events and password changes, encrypts each
change into an operation, and appends it to the server log. The server assigns
sequence numbers and broadcasts new operations over WebSocket. Every client
replays the log, so all machines converge to the same state. 

Encryption runs in the browser with WebCrypto. A master password derives, via
PBKDF2, an AES-GCM key and an auth token. 

## Server

Compile the server on Linux:

```bash
go build -ldflags="-s -w" .
```

This produces the `./bs` binary. Run it from the directory that holds
`config.json` and `data.db`.

### Configuration

`config.json` has two fields. Both are optional; missing fields fall back to
defaults, so a first run works with no config file at all.

```json
{
  "port": 8000,
  "token": ""
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `8000` | Port to listen on |
| `token` | empty | Config token that authorizes auth token registration |

On first start, if `token` is empty, `bs` generates one, prints it to the
terminal, and writes it back into `config.json`. Keep it secret. It is only
needed once per client to register an auth token.

### Commands

```bash
# run in foreground
./bs run --config config.json

# start daemon, enable auto-start
sudo ./bs install --config config.json

# stop daemon, disable auto-start
sudo ./bs uninstall

# show daemon and service health
./bs status --config config.json

# show version
./bs version
```

`install` writes a systemd unit and starts the service. `status` checks the
config file, the database, the systemd unit state, and probes the daemon over
HTTP. It exits 0 when healthy and 1 otherwise, so it works in scripts.

### HTTP API

All data routes require a bearer auth token except registration and status.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/status` | GET | Health probe, reports whether an auth token is registered |
| `/api/register` | POST | Register an auth token, authorized by the config token |
| `/api/ops` | GET | Pull operations after a sequence number |
| `/api/ops` | POST | Append operations to a log |
| `/api/reset` | POST | Truncate a log and bump its generation |
| `/api/ws` | GET | WebSocket that broadcasts new operations |

## Extension

Pure JavaScript, no build dependencies. `build.sh` produces three artifacts.

```bash
cd extension
./build.sh
```

| Artifact | Target | How to load |
| --- | --- | --- |
| `dist/` | Chrome, Edge, Helium | `chrome://extensions`, developer mode, "Load unpacked" |
| `bs.xpi` | Firefox, Zen | Drag into `about:addons` (set `xpinstall.signatures.required` to `false` first) |
| `dist.zip` | Chrome | Unzip to get `dist/` |

Manifest V3. Chrome uses a service worker background, Firefox uses a
background script; both share one codebase.
