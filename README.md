# BotTap

**Your bots already have buttons. Now your glasses can press them.**

**Live Browser Sandbox (zero setup):** [https://bottap.pages.dev](https://bottap.pages.dev) — runs deterministic in-browser fixtures enforcing the exact same shared classifier, 2FA refusal, and two-step destructive arm-token gate without connecting to Telegram.

**Demo Video (1:55, live MTProto Layer 234 + EvenHub Simulator LVGL):** [https://youtu.be/hGlkLUvwyKs](https://youtu.be/hGlkLUvwyKs)

BotTap is an on-duty bot button deck for **Even Realities G2** smart glasses and the **R1 ring**, backed by a minimal self-hosted **unofficial Telegram API** gateway.

Open BotTap when you want to clear pending operational alerts (uptime acks, deploy gates, on-call approvals). It scans only explicitly allowlisted bots (and optional allowlisted ops groups) for messages with inline callback buttons, shows one 40-character alert excerpt line and up to three buttons on the 576x288 monochrome waveguide display, and executes presses via `messages.getBotCallbackAnswer`.

No chat lists. No full message history. No free-text drafting. Intentionally voice-free: destructive production actions rely on deterministic R1 ring clicks and two-step arm confirmation instead of speech recognition in noisy rooms.

---

## Protocol-Level Safety Model

Safety rules are enforced on **both** the G2 lens and the self-hosted gateway — not just in UI copy:

| Telegram Protocol Signal / Boundary | BotTap Behavior (G2 + Gateway) |
|---|---|
| Non-allowlisted chat / bot | Invisible on `GET /pending`; rejected with HTTP `403` on `POST /press`. Group scans (`BOTTAP_GROUPS`) still verify the sender is an allowlisted bot (`entity.bot === true`) |
| `InlineButtonTypeUrl`, `WebView`, `Game`, `Buy`, `SwitchInline`, `Copy`, `Disabled` (Layer 234 & legacy equivalents) | Stripped at the gateway parser boundary — never rendered on glasses |
| Destructive callbacks: `KeyboardButtonStyle.bgDanger` (MTProto Layer 234) + conservative lexical safety floor for unstyled destructive verbs (`approve prod`, `rollback`, `delete`, `terminate`, `revoke`, `rotate key`, `purge`, `drain`) | First tap arms `TAP AGAIN TO CONFIRM` (6s auto-disarm) and requests a single-use server `POST /arm` token (8s TTL) bound to `(chatPeer, bot, msgId, dataB64, alert line)`. Gateway rejects unconfirmed, expired, replayed, or post-edit presses (`HTTP 409`) |
| `InlineButtonTypeCallback.requiresPassword: true` (2FA-gated) | Refused immediately on G2 (`2FA button - open Telegram`) and rejected with HTTP `403` on gateway |
| Chat reading / message sending | **No endpoints exist.** The gateway exposes only pending callback buttons, danger arming, callback press, allowlist/group management, and rate-limited local pairing |
| Network & transport boundary | Binds `127.0.0.1` by default, fails closed in live mode without `BOTTAP_TOKEN` on non-loopback hosts or behind reverse-proxy headers, blocks cross-origin `POST`/`DELETE` from unlisted origins, and refuses non-loopback plaintext HTTP in the companion client |
| `BOT_RESPONSE_TIMEOUT` & scan failures | Timeouts render `NO ANSWER (LOGGED)` and record in the audit trail; flood-waits or unstarted bots render `SCAN WARNING` instead of a false `All clear`; pressed buttons persist a 30-minute tombstone so static keyboards don't reappear as ghosts |

> **Security note on MTProto sessions:** Because Telegram MTProto does not support bot-only scoped user tokens, `/data/session.txt` (`0600`) is a standard Telegram user session. Protect your self-hosted gateway machine the same way you protect a Telegram Desktop session; BotTap enforces its narrow operational scope at the gateway boundary.

---

## Architecture

```text
Even G2 + R1 Ring (576x288 mono)
       │  @evenrealities/even_hub_sdk (BLE bridge)
       ▼
Even App WebView / Companion UI (app/)
       │  GET /pending · POST /arm · POST /press  (optional Bearer token)
       ▼
Self-Hosted BotTap Gateway (gateway/, Docker / Node 24)
       │  MTProto Layer 234 (teleproto) — StringSession stays local (0600)
       ▼
Allowlisted Telegram Bots & Ops Groups (messages.getBotCallbackAnswer)
```

- `shared/` — Zero-dependency pure functional core: Telegram Layer 234 (`KeyboardInlineButton` / `InlineButtonTypeCallback`) + legacy callback classifier, dual-signal danger policy, Unicode-safe 40-char single-line alert sanitizer, allowlist/group normalizer, and deterministic G2 lens state machine (`reduceG2State`).
- `gateway/` — Self-hosted Node 24 HTTP server + `teleproto` Layer 234 MTProto transport + atomic `0600` session/audit/tombstone store + one-command Docker container. Includes an explicitly labelled `--demo` offline sandbox transport for testing without Telegram credentials.
- `app/` — Vite + TypeScript Even Hub app (`@evenrealities/even_hub_sdk`), 576x288 monochrome renderer, R1 ring event router, companion WebView with scannable SVG QR pairing, phone+code/2FA pairing, allowlist management, audit logs, and an opt-in static browser sandbox build (`npm --workspace=app run build:sandbox`).
- `demo-bots/` — Zero-dependency Telegram Bot API long-polling runner that sends real inline-keyboard alerts (`/uptime`, `/deploy` with `style: "danger"`, `/slow` timeout test, `/all`) against your own `@BotFather` bot for end-to-end testing with live Telegram accounts.

---

## Quick Start

### 1. Instant Browser Sandbox (no install or Telegram account)

Open [https://bottap.pages.dev](https://bottap.pages.dev) (or run `npm --workspace=app run build:sandbox` locally) to test the full 576x288 optical lens mirror, R1 ring controls, ops group alert (`#ops-alerts`), two-step danger arming, 2FA refusal, and audit trail in-browser.

### 2. Local Gateway Sandbox (`--demo`)

```bash
npm install
npm run build
npm test
npm run dev:gateway:demo
```

In a second terminal:

```bash
npm run dev:app
```

Open `http://127.0.0.1:5173` in a browser or launch the official Even Hub simulator:

```bash
npm run simulate
```

Controls in the companion view / keyboard mirror the R1 ring:
- **Swipe Up / Down** (`ArrowUp` / `ArrowDown`) — cycle queue items or buttons (cancels an armed danger press)
- **Tap** (`Enter` / `Space`) — open item, arm/press button, or confirm an armed danger button
- **Double-Tap** (`Escape` / `Backspace`) — go back to queue, or exit cleanly from the root screen

### 3. Self-Hosted Live MTProto Gateway (One Command via Docker)

1. Create your own Telegram API credentials (`api_id` and `api_hash`) at [my.telegram.org](https://my.telegram.org) using an aged Telegram account.
2. Copy `.env.example` to `.env` and fill in `TG_API_ID`, `TG_API_HASH`, `BOTTAP_ALLOWLIST` (plus optional `BOTTAP_GROUPS` for shared ops channels/supergroups), and a strong `BOTTAP_TOKEN` (minimum 12 characters; required for live mode inside Docker or on non-loopback hosts):

```bash
cp .env.example .env
docker compose up -d --build
```

3. `docker-compose.yml` binds strictly to `127.0.0.1:8788` by default. Open `http://127.0.0.1:8788` locally — or front it with an HTTPS reverse proxy (Caddy, Tailscale Serve, or Cloudflare Tunnel) before accessing it from your phone or Even G2 WebView. Pair via **QR** or **phone + code** (your MTProto session stays inside `/data/session.txt` with `0600` permissions).

> **Connecting a physical phone / Even Hub `.ehpk` WebView:** Add your gateway's HTTPS hostname to `permissions.network.whitelist` in `app/app.json` before running `npm run pack:g2`, and add your Even App origin to `BOTTAP_CORS_ORIGIN` on the gateway.

### 4. Live Telegram Demo Bot (Real Account Testing)

To test the full MTProto loop against a real Telegram bot without mocks:

1. Create a test bot with `@BotFather` and export its token as `DEMO_BOT_TOKEN`.
2. Add the bot's username to `BOTTAP_ALLOWLIST` in the companion app or `.env`.
3. Run the zero-dependency Bot API runner:

```bash
DEMO_BOT_TOKEN=123456:your-bot-token npm run demo:bot
```

4. Message your bot `/all` (or `/uptime`, `/deploy`, `/slow`) in Telegram. It sends real inline callback alerts including a `style: "danger"` deploy gate (triggering G2's double-press safety gate), real URL buttons (stripped at the gateway), and an unanswered callback to verify `BOT_RESPONSE_TIMEOUT` logging.

### 5. Pack `.ehpk` for Even Hub

```bash
npm run pack:g2
```

Produces `app/dist/bottap.ehpk` validated against `app/app.json`.

---

## Gateway API Surface

Only these operational routes exist:

- `GET /health` — liveness, active mode (`live` or `demo`), and `tokenRequired` boolean (no account/pairing metadata exposed unauthenticated)
- `GET /status` — pairing state, allowlist, ops groups, pending count, scan diagnostics, and recent press/policy audit log
- `GET /pending` — allowlisted bots' and ops groups' pending callback-only button items + scan diagnostics
- `POST /arm` — `{ bot, chatPeer?, msgId, dataB64 }` → issues a single-use 8s TTL `armToken` bound to a destructive button and its current sanitized alert line
- `POST /press` — `{ bot, chatPeer?, msgId, dataB64, confirmedDanger?, armToken? }` → executes `messages.getBotCallbackAnswer` after allowlist, 2FA, and server-bound danger gates
- `GET /allowlist`, `POST /allowlist`, `DELETE /allowlist/:bot` — manage allowlisted bot handles (audited)
- `GET /groups`, `POST /groups`, `DELETE /groups/:group` — manage allowlisted ops group peers (`-100...` or `@group`)
- `POST /pairing/qr`, `GET /pairing/qr`, `POST /pairing/phone`, `POST /pairing/code`, `POST /pairing/2fa`, `POST /pairing/disconnect` — local MTProto pairing lifecycle

There are intentionally **no** `/chats`, `/messages`, `/dialogs`, or `/send` routes.

---

## What Existed Before Nov 23

All BotTap source code (`shared/`, `gateway/`, `app/`, `demo-bots/`, tests, CI workflow, Dockerfile, and documentation) was written from scratch after the Heads Up hackathon kickoff on **November 23, 2026**.

Pre-existing open-source libraries, templates, and APIs used:
- Even Hub starter patterns from `even-realities/evenhub-templates` (`minimal` & `text-heavy`)
- Official Even Realities packages (`@evenrealities/even_hub_sdk`, `@evenrealities/evenhub-cli`, `@evenrealities/evenhub-simulator`)
- `teleproto` MTProto client library for Telegram Layer 234
- `uqr` zero-dependency QR encoder for scannable SVG pairing
- Self-hosted Fontsource fonts (`Familjen Grotesk`, `IBM Plex Sans`, `JetBrains Mono`)
- Vite and TypeScript toolchains

---

## Credits

| Dependency / Reference | Role | License |
|---|---|---|
| [`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) | Even G2 BLE bridge & container primitives | MIT |
| [`@evenrealities/evenhub-cli`](https://www.npmjs.com/package/@evenrealities/evenhub-cli) & [`evenhub-simulator`](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) | `.ehpk` packaging & desktop G2 simulator | MIT |
| [`even-realities/evenhub-templates`](https://github.com/even-realities/evenhub-templates) | Official protobuf `eventTypeOf` & companion WebView conventions | MIT |
| [`teleproto`](https://www.npmjs.com/package/teleproto) | Telegram MTProto Layer 234 client (`KeyboardInlineButton`, `KeyboardButtonStyle.bgDanger`, `GetBotCallbackAnswer`) | Apache-2.0 |
| [`uqr`](https://www.npmjs.com/package/uqr) | Zero-dependency QR encoder for scannable SVG Telegram login pairing | MIT |
| [`@fontsource/familjen-grotesk`](https://fontsource.org/fonts/familjen-grotesk), [`ibm-plex-sans`](https://fontsource.org/fonts/ibm-plex-sans), [`jetbrains-mono`](https://fontsource.org/fonts/jetbrains-mono) | Self-hosted offline typography bundled into `.ehpk` | OFL-1.1 |
| [`vite`](https://vite.dev/) & [`typescript`](https://www.typescriptlang.org/) | Build and type-checking toolchain | MIT / Apache-2.0 |

---

## Telegram API Notice

BotTap is an **unofficial Telegram API client** that runs strictly on infrastructure you control. It is not affiliated with or endorsed by Telegram FZ-LLC, does not use Telegram branding or logos, requires your own `api_id` / `api_hash`, and never trains AI models on Telegram data.
