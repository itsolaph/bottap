import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  initialG2State,
  reduceG2State,
  type G2Action,
  type G2ViewState,
  type GatewayMode,
  type GatewayStatus,
} from '@bottap/shared'
import { GatewayClient } from './client'
import { renderG2Frame, type G2Frame } from './g2-renderer'
import './styles.css'

const STORAGE_URL_KEY = 'bottap.gatewayUrl'
const STORAGE_TOKEN_KEY = 'bottap.gatewayToken'

function defaultGatewayUrl(): string {
  const saved = window.localStorage.getItem(STORAGE_URL_KEY)
  if (saved) return saved
  // In Vite dev mode (/api proxy) or self-hosted single-container mode, same-origin works cleanly
  if (window.location.port === '5173') {
    return `${window.location.origin}/api`
  }
  return window.location.origin
}

const client = new GatewayClient({
  baseUrl: defaultGatewayUrl(),
  token: window.localStorage.getItem(STORAGE_TOKEN_KEY) ?? '',
})

let bridge: EvenAppBridge | null = null
let bridgeReady = false
let g2State: G2ViewState = initialG2State()
let lastStatus: GatewayStatus | null = null
let lastMeta: { allowlistCount: number; mode: GatewayMode } = {
  allowlistCount: 0,
  mode: 'live',
}
let lastRenderedKey = ''
let bridgeWriteQueue: Promise<unknown> = Promise.resolve()
let pairingMessage = ''
let qrPollTimer: number | null = null

// Official Even Hub protobuf envelope helper:
// CLICK_EVENT is 0, omitted on the wire; default MUST resolve inside the envelope check.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pushFrameToG2(frame: G2Frame): void {
  const key = `${frame.body}\u0000${frame.footer}`
  if (key === lastRenderedKey) return
  lastRenderedKey = key

  const bodyEl = document.getElementById('lens-body')
  const footerEl = document.getElementById('lens-footer')
  if (bodyEl) bodyEl.textContent = frame.body
  if (footerEl) footerEl.textContent = frame.footer

  if (!bridge || !bridgeReady) return

  const activeBridge = bridge
  bridgeWriteQueue = bridgeWriteQueue
    .then(async () => {
      await activeBridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'body',
          content: frame.body,
        }),
      )
      await activeBridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 2,
          containerName: 'footer',
          content: frame.footer,
        }),
      )
    })
    .catch((err) => console.error('[bottap] G2 upgrade failed:', err))
}

function renderAll(): void {
  const frame = renderG2Frame(g2State, Date.now())
  pushFrameToG2(frame)
  renderCompanionShell(frame)
}

function dispatch(action: G2Action): void {
  const { state, effect } = reduceG2State(g2State, action, lastMeta)
  g2State = state
  renderAll()

  if (!effect) return
  if (effect.type === 'SHUTDOWN_G2') {
    bridge?.shutDownPageContainer(1).catch((err) => console.error(err))
    return
  }
  if (effect.type === 'REFRESH') {
    void refreshFromGateway()
    return
  }
  if (effect.type === 'PRESS') {
    void (async () => {
      try {
        const outcome = await client.press(effect.req)
        dispatch({ type: 'PRESS_DONE', outcome, now: Date.now() })
      } catch (err) {
        dispatch({
          type: 'PRESS_DONE',
          now: Date.now(),
          outcome: {
            ok: false,
            code: 'TRANSPORT_ERROR',
            message: err instanceof Error ? err.message : 'Network error',
          },
        })
      }
    })()
  }
}

async function refreshFromGateway(): Promise<void> {
  try {
    const [status, pending] = await Promise.all([client.getStatus(), client.getPending()])
    lastStatus = status
    lastMeta = {
      allowlistCount: status.allowlist.length,
      mode: status.mode,
    }
    dispatch({
      type: 'SYNC_OK',
      paired: pending.paired,
      mode: pending.mode,
      allowlistCount: pending.allowlist.length,
      items: pending.items,
    })
  } catch (err) {
    lastStatus = null
    dispatch({
      type: 'SYNC_ERROR',
      message: err instanceof Error ? err.message : 'Gateway unreachable',
    })
  }
}

async function initEvenBridge(): Promise<void> {
  try {
    const maybeBridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ])
    if (!maybeBridge) return

    bridge = maybeBridge
    const initialFrame = renderG2Frame(g2State, Date.now())

    const bodyContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 244,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'body',
      content: initialFrame.body,
      isEventCapture: 1,
    })

    const footerContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 250,
      width: 576,
      height: 34,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: 2,
      containerName: 'footer',
      content: initialFrame.footer,
      isEventCapture: 0,
    })

    const res = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 2,
        textObject: [bodyContainer, footerContainer],
      }),
    )

    if (res === 0) {
      bridgeReady = true
      lastRenderedKey = `${initialFrame.body}\u0000${initialFrame.footer}`
    }

    const unsubscribe = bridge.onEvenHubEvent((event) => {
      const sysType = eventTypeOf(event.sysEvent)
      const textType = eventTypeOf(event.textEvent)

      // Match explicit non-zero event types BEFORE CLICK_EVENT (0)
      if (
        sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
        textType === OsEventTypeList.DOUBLE_CLICK_EVENT
      ) {
        dispatch({ type: 'DOUBLE_TAP' })
        return
      }
      if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
        dispatch({ type: 'SCROLL_UP' })
        return
      }
      if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        dispatch({ type: 'SCROLL_DOWN' })
        return
      }
      if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
        dispatch({ type: 'TAP', now: Date.now() })
        return
      }
      if (
        sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        unsubscribe()
      }
    })

    window.addEventListener('beforeunload', () => unsubscribe())
  } catch (err) {
    console.warn('[bottap] Even Hub bridge not active (running in standalone browser preview):', err)
  }
}

function renderCompanionShell(frame: G2Frame): void {
  const root = document.getElementById('app')
  if (!root) return

  const cfg = client.getConfig()
  const pillClass = !lastStatus
    ? 'offline'
    : lastStatus.mode === 'demo'
      ? 'demo'
      : lastStatus.pairing.status === 'paired'
        ? 'live'
        : 'offline'

  const pillText = !lastStatus
    ? 'OFFLINE'
    : lastStatus.mode === 'demo'
      ? `DEMO · ${lastStatus.pendingCount} PENDING`
      : lastStatus.pairing.status === 'paired'
        ? `LIVE · ${lastStatus.pendingCount} PENDING`
        : 'UNPAIRED'

  const allowlist = lastStatus?.allowlist ?? []
  const audit = lastStatus?.recentAudit.slice(0, 6) ?? []
  const pairing = lastStatus?.pairing

  root.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-row">
            <span class="brand-name">BOTTAP</span>
          </div>
          <span class="brand-sub">On-duty bot button deck · Even G2 + R1 Ring</span>
        </div>
        <span class="pill ${pillClass}"><span class="dot"></span>${escapeHtml(pillText)}</span>
      </header>

      <section class="card" aria-label="G2 Waveguide Display Mirror">
        <div class="card-head">
          <span class="card-title">G2 Optical Display (576×288 Mono)</span>
          <button id="btn-refresh" class="small" type="button">Sync</button>
        </div>
        <div class="lens-frame">
          <pre id="lens-body" class="lens-body">${escapeHtml(frame.body)}</pre>
          <div id="lens-footer" class="lens-footer">${escapeHtml(frame.footer)}</div>
        </div>
        <div class="ring-controls" aria-label="R1 Ring Controls">
          <button id="ring-up" type="button">Swipe Up</button>
          <button id="ring-tap" class="primary" type="button">Tap</button>
          <button id="ring-down" type="button">Swipe Down</button>
          <button id="ring-double" type="button">2x Tap</button>
        </div>
      </section>

      <section class="card" aria-label="Allowlisted Bots">
        <div class="card-head">
          <span class="card-title">Allowlisted Bots (${allowlist.length})</span>
          ${
            lastStatus?.mode === 'demo'
              ? '<button id="btn-demo-reset" class="small danger-btn" type="button">Reset Demo</button>'
              : ''
          }
        </div>
        <div class="chips">
          ${
            allowlist.length
              ? allowlist
                  .map(
                    (bot) =>
                      `<span class="chip">@${escapeHtml(bot)}<button data-remove-bot="${escapeHtml(bot)}" title="Remove" type="button">×</button></span>`,
                  )
                  .join('')
              : '<span class="hint">No bots allowlisted yet. Add a bot handle below.</span>'
          }
        </div>
        <form id="form-allowlist" class="row">
          <input id="input-bot" type="text" placeholder="@uptime_ops_bot" autocomplete="off" />
          <button type="submit">Add Bot</button>
        </form>
        <p class="hint">Only inline callback buttons from allowlisted bots appear on glasses. URL, Mini App, and 2FA buttons are blocked at the gateway.</p>
      </section>

      <section class="card" aria-label="Self-Hosted Gateway Pairing">
        <div class="card-head">
          <span class="card-title">Self-Hosted Gateway</span>
          <span class="hint">${escapeHtml(pairing?.accountLabel || pairing?.status || 'disconnected')}</span>
        </div>
        <form id="form-gateway" class="row">
          <input id="input-url" type="url" value="${escapeHtml(cfg.baseUrl)}" placeholder="http://127.0.0.1:8788" />
          <input id="input-token" type="password" value="${escapeHtml(cfg.token ?? '')}" placeholder="Bearer token (optional)" />
          <button type="submit">Save</button>
        </form>
        ${
          pairing?.mode === 'live'
            ? `
          <div class="row">
            <button id="btn-qr" class="primary" type="button">Start QR Pairing</button>
            ${
              pairing.status === 'paired'
                ? '<button id="btn-disconnect" class="danger-btn" type="button">Sign Out</button>'
                : ''
            }
          </div>
          ${
            pairing.qrUrl
              ? `<div class="qr-box">Scan or open on Telegram mobile:<br/>${escapeHtml(pairing.qrUrl)}</div>`
              : ''
          }
          ${
            pairing.status === 'unpaired'
              ? `<form id="form-phone" class="row"><input id="input-phone" type="tel" placeholder="+628..." /><button type="submit">Send Code</button></form>`
              : ''
          }
          ${
            pairing.status === 'awaiting_code'
              ? `<form id="form-code" class="row"><input id="input-code" type="text" placeholder="Login code (${escapeHtml(pairing.phoneMask ?? '')})" /><button type="submit">Verify Code</button></form>`
              : ''
          }
          ${
            pairing.status === 'awaiting_2fa'
              ? `<form id="form-2fa" class="row"><input id="input-2fa" type="password" placeholder="Telegram 2FA cloud password" /><button type="submit">Unlock</button></form>`
              : ''
          }
        `
            : '<p class="hint">Running offline Demo Sandbox fixtures. Switch gateway to live MTProto mode with TG_API_ID + TG_API_HASH to pair a real account.</p>'
        }
        ${pairingMessage ? `<p class="hint">${escapeHtml(pairingMessage)}</p>` : ''}
      </section>

      <section class="card" aria-label="Press Audit Log">
        <div class="card-head">
          <span class="card-title">Recent Press Audit (${audit.length})</span>
        </div>
        <div class="audit-list">
          ${
            audit.length
              ? audit
                  .map(
                    (a) => `
                  <div class="audit-row">
                    <span>@${escapeHtml(a.bot)} · ${escapeHtml(a.buttonLabel)}</span>
                    <span class="audit-outcome ${escapeHtml(a.outcome)}">${escapeHtml(a.outcome.replace(/_/g, ' '))}</span>
                  </div>`,
                  )
                  .join('')
              : '<span class="hint">No button presses recorded yet.</span>'
          }
        </div>
      </section>

      <footer class="footer-tos">
        BotTap is an unofficial Telegram API client running strictly against your own self-hosted gateway.
        MTProto sessions never leave your machine. No chat lists, no message bodies, no free-text sending, and no AI training on Telegram data.
      </footer>
    </main>
  `

  document.getElementById('ring-up')?.addEventListener('click', () => dispatch({ type: 'SCROLL_UP' }))
  document.getElementById('ring-down')?.addEventListener('click', () => dispatch({ type: 'SCROLL_DOWN' }))
  document.getElementById('ring-tap')?.addEventListener('click', () => dispatch({ type: 'TAP', now: Date.now() }))
  document.getElementById('ring-double')?.addEventListener('click', () => dispatch({ type: 'DOUBLE_TAP' }))
  document.getElementById('btn-refresh')?.addEventListener('click', () => void refreshFromGateway())

  document.getElementById('btn-demo-reset')?.addEventListener('click', async () => {
    await client.resetDemo()
    await refreshFromGateway()
  })

  document.querySelectorAll<HTMLButtonElement>('[data-remove-bot]').forEach((el) => {
    el.addEventListener('click', async () => {
      const bot = el.dataset.removeBot
      if (!bot) return
      await client.removeAllowlist(bot)
      await refreshFromGateway()
    })
  })

  document.getElementById('form-allowlist')?.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const input = document.getElementById('input-bot') as HTMLInputElement | null
    const val = input?.value.trim()
    if (!val) return
    try {
      await client.addAllowlist(val)
      if (input) input.value = ''
      pairingMessage = ''
      await refreshFromGateway()
    } catch (err) {
      pairingMessage = err instanceof Error ? err.message : 'Invalid bot handle'
      renderAll()
    }
  })

  document.getElementById('form-gateway')?.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const url = (document.getElementById('input-url') as HTMLInputElement | null)?.value.trim()
    const tok = (document.getElementById('input-token') as HTMLInputElement | null)?.value.trim() ?? ''
    if (!url) return
    window.localStorage.setItem(STORAGE_URL_KEY, url)
    window.localStorage.setItem(STORAGE_TOKEN_KEY, tok)
    client.configure({ baseUrl: url, token: tok })
    void refreshFromGateway()
  })

  document.getElementById('btn-qr')?.addEventListener('click', async () => {
    try {
      const res = await client.startQrPairing()
      pairingMessage = res.pairing.error || 'Waiting for Telegram QR confirmation...'
      await refreshFromGateway()
      if (qrPollTimer) window.clearInterval(qrPollTimer)
      qrPollTimer = window.setInterval(async () => {
        const polled = await client.pollQrPairing()
        if (polled.pairing.status === 'paired' && qrPollTimer) {
          window.clearInterval(qrPollTimer)
          qrPollTimer = null
          pairingMessage = 'Paired.'
        }
        await refreshFromGateway()
      }, 3000)
    } catch (err) {
      pairingMessage = err instanceof Error ? err.message : 'QR pairing failed'
      renderAll()
    }
  })

  document.getElementById('btn-disconnect')?.addEventListener('click', async () => {
    await client.disconnect()
    pairingMessage = 'Session cleared on gateway.'
    await refreshFromGateway()
  })

  document.getElementById('form-phone')?.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const phone = (document.getElementById('input-phone') as HTMLInputElement | null)?.value.trim()
    if (!phone) return
    try {
      await client.startPhonePairing(phone)
      pairingMessage = 'Code sent to your Telegram app.'
      await refreshFromGateway()
    } catch (err) {
      pairingMessage = err instanceof Error ? err.message : 'Send code failed'
      renderAll()
    }
  })

  document.getElementById('form-code')?.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const code = (document.getElementById('input-code') as HTMLInputElement | null)?.value.trim()
    if (!code) return
    try {
      await client.submitPhoneCode(code)
      pairingMessage = ''
      await refreshFromGateway()
    } catch (err) {
      pairingMessage = err instanceof Error ? err.message : 'Code verification failed'
      renderAll()
    }
  })

  document.getElementById('form-2fa')?.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const pw = (document.getElementById('input-2fa') as HTMLInputElement | null)?.value
    if (!pw) return
    try {
      await client.submit2FA(pw)
      pairingMessage = ''
      await refreshFromGateway()
    } catch (err) {
      pairingMessage = err instanceof Error ? err.message : '2FA unlock failed'
      renderAll()
    }
  })
}

// Keyboard shortcuts for fast desktop/simulator testing (mirrors R1 ring)
window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return
  if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    dispatch({ type: 'SCROLL_UP' })
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    dispatch({ type: 'SCROLL_DOWN' })
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault()
    dispatch({ type: 'TAP', now: Date.now() })
  } else if (ev.key === 'Escape' || ev.key === 'Backspace') {
    ev.preventDefault()
    dispatch({ type: 'DOUBLE_TAP' })
  }
})

// Boot sequence
renderAll()
void initEvenBridge()
void refreshFromGateway()

window.setInterval(() => {
  dispatch({ type: 'TICK', now: Date.now() })
}, 500)

window.setInterval(() => {
  if (g2State.screen === 'queue' || g2State.screen === 'empty' || g2State.screen === 'unpaired') {
    void refreshFromGateway()
  }
}, 5000)
