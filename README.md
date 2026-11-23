# BotTap

**Your bots already have buttons. Now your glasses can press them.**

BotTap is an on-duty bot button deck for **Even Realities G2** smart glasses and the **R1 ring**, backed by a minimal self-hosted **unofficial Telegram API** gateway.

Open BotTap when you want to check pending operational alerts (uptime acks, deploy gates, on-call approvals). It scans only allowlisted bots for messages with inline callback buttons, shows one short alert line and up to three buttons on the 576x288 monochrome waveguide display, and presses the button via `messages.getBotCallbackAnswer`.

No chat lists. No message bodies. No free-text drafting.

---

## Protocol-Level Safety Model

Safety rules are enforced on **both** the G2 lens and the self-hosted gateway — not just in UI copy:

| Telegram Protocol Signal | BotTap Behavior (G2 + Gateway) |
|---|---|
| Non-allowlisted chat / bot | Invisible on `GET /pending`; rejected with HTTP `403` on `POST /press` |
| `KeyboardButtonUrl`, `KeyboardButtonWebView`, `KeyboardButtonGame`, `KeyboardButtonBuy`, `KeyboardButtonSwitchInline`, `KeyboardButtonCopy` | Stripped at the gateway parser boundary — never rendered on glasses |
| `KeyboardButtonCallback` with `style.bgDanger` (Telegram MTProto Layer 234 `KeyboardButtonStyle`) | First tap arms `PRESS AGAIN TO CONFIRM` (6s auto-disarm); gateway rejects without `confirmedDanger: true` (`HTTP 409`) |
| `KeyboardButtonCallback` with `requiresPassword: true` (2FA-gated) | Refused immediately on G2 (`2FA button - open Telegram`) and rejected with HTTP `403` on gateway |
| Chat reading / message sending | **No endpoints exist.** The gateway exposes only pending callback buttons, callback press, allowlist, and local pairing |
| `BOT_RESPONSE_TIMEOUT` | Handled gracefully (`Bot did not answer`), logged in the audit trail |

---

## Architecture

```text
Even G2 + R1 Ring (576x288 mono)
       │  @evenrealities/even_hub_sdk (BLE bridge)
       ▼
Even App WebView / Companion UI (app/)
       │  GET /pending  ·  POST /press  (optional Bearer token)
       ▼
Self-Hosted BotTap Gateway (gateway/, Docker / Node 24)
       │  MTProto Layer 234 (teleproto) — StringSession stays local (0600)
       ▼
Allowlisted Telegram Bots (messages.getBotCallbackAnswer)
```

- `shared/` — Zero-dependency pure functional core: strict inline-button classifier, 40-char single-line alert sanitizer, allowlist normalizer, and deterministic G2 lens state machine (`reduceG2State`).
- `gateway/` — Self-hosted Node 24 HTTP server + `teleproto` Layer 234 MTProto transport + atomic `0600` session/audit store + one-command Docker container. Includes an explicitly labelled `--demo` offline sandbox transport for testing without Telegram credentials.
- `app/` — Vite + TypeScript Even Hub app (`@evenrealities/even_hub_sdk`), 576x288 monochrome renderer, R1 ring event router, and companion WebView for QR / phone+code pairing, allowlist management, and audit logs.

---

## Quick Start

### 1. Local Offline Sandbox (no Telegram account required)

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

Open `http://localhost:5173` in a browser or launch the official Even Hub simulator:

```bash
npm run simulate
```

Controls in the companion view / keyboard mirror the R1 ring:
- **Swipe Up / Down** (`ArrowUp` / `ArrowDown`) — cycle queue items or buttons (cancels an armed danger press)
- **Tap** (`Enter` / `Space`) — open item, press button, or confirm an armed danger button
- **Double-Tap** (`Escape` / `Backspace`) — go back to queue, or exit cleanly from the root screen

### 2. Self-Hosted Live MTProto Gateway (One Command via Docker)

1. Create your own Telegram API credentials (`api_id` and `api_hash`) at [my.telegram.org](https://my.telegram.org) using an aged Telegram account.
2. Copy `.env.example` to `.env` and fill in `TG_API_ID`, `TG_API_HASH`, `BOTTAP_ALLOWLIST`, and optionally `BOTTAP_TOKEN`:

```bash
cp .env.example .env
docker compose up -d --build
```

3. Open `http://<your-host>:8788` in your phone or desktop browser, pair via **QR** or **phone + code** (your MTProto session file stays inside the Docker volume `/data/session.txt` with `0600` permissions), and point the Even Hub app at your gateway URL.

### 3. Pack `.ehpk` for Even Hub

```bash
npm run pack:g2
```

Produces `app/dist/bottap.ehpk` validated against `app/app.json`.

---

## Gateway API Surface

Only these operational routes exist:

- `GET /health` — liveness, active mode (`live` or `demo`), and pairing flag
- `GET /status` — pairing state, allowlist, pending count, and recent press audit log
- `GET /pending` — allowlisted bots' pending callback-only button items
- `POST /press` — `{ bot, msgId, dataB64, confirmedDanger? }` → executes `messages.getBotCallbackAnswer` after allowlist, 2FA, and `bg_danger` gates
- `GET /allowlist`, `POST /allowlist`, `DELETE /allowlist/:bot` — manage allowlisted bot handles
- `POST /pairing/qr`, `GET /pairing/qr`, `POST /pairing/phone`, `POST /pairing/code`, `POST /pairing/2fa`, `POST /pairing/disconnect` — local MTProto pairing lifecycle

There are intentionally **no** `/chats`, `/messages`, `/dialogs`, or `/send` routes.

---

## What Existed Before Nov 23

All BotTap source code (`shared/`, `gateway/`, `app/`, tests, Dockerfile, and documentation) was written from scratch after the Heads Up hackathon kickoff on **November 23, 2026**.

Pre-existing open-source libraries, templates, and APIs used:
- Even Hub starter patterns from `even-realities/evenhub-templates` (`minimal` & `text-heavy`)
- Official Even Realities packages (`@evenrealities/even_hub_sdk`, `@evenrealities/evenhub-cli`, `@evenrealities/evenhub-simulator`)
- `teleproto` MTProto client library for Telegram Layer 234
- Vite and TypeScript toolchains

---

## Credits

| Dependency / Reference | Role | License |
|---|---|---|
| [`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) | Even G2 BLE bridge & container primitives | MIT |
| [`@evenrealities/evenhub-cli`](https://www.npmjs.com/package/@evenrealities/evenhub-cli) & [`evenhub-simulator`](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) | `.ehpk` packaging & desktop G2 simulator | MIT |
| [`even-realities/evenhub-templates`](https://github.com/even-realities/evenhub-templates) | Official protobuf `eventTypeOf` & companion WebView conventions | MIT |
| [`teleproto`](https://www.npmjs.com/package/teleproto) | Telegram MTProto Layer 234 client (`KeyboardButtonStyle.bgDanger`, `GetBotCallbackAnswer`) | Apache-2.0 |
| [`vite`](https://vite.dev/) & [`typescript`](https://www.typescriptlang.org/) | Build and type-checking toolchain | MIT / Apache-2.0 |

---

## Telegram API Notice

BotTap is an **unofficial Telegram API client** that runs strictly on infrastructure you control. It is not affiliated with or endorsed by Telegram FZ-LLC, does not use Telegram branding or logos, requires your own `api_id` / `api_hash`, and never trains AI models on Telegram data.
