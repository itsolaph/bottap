import '@fontsource/familjen-grotesk/latin-500.css'
import '@fontsource/familjen-grotesk/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './tokens.css'
import './styles.css'

import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  formatRelativeAge,
  initialG2State,
  reduceG2State,
  type G2Action,
  type G2ViewState,
  type GatewayMode,
  type GatewayStatus,
  type QueueItem,
} from '@bottap/shared'
import { GatewayClient } from './client'
import { renderG2Frame, type G2Frame } from './g2-renderer'
import { createQrSvgElement } from './qr-svg'

const STORAGE_URL_KEY = 'bottap.gatewayUrl'
const STORAGE_TOKEN_KEY = 'bottap.gatewayToken'

function defaultGatewayUrl(): string {
  const saved = window.localStorage.getItem(STORAGE_URL_KEY)
  if (saved) return saved
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
let lastItems: readonly QueueItem[] = []
let lastMeta: { allowlistCount: number; mode: GatewayMode } = {
  allowlistCount: 0,
  mode: 'live',
}
let lastRenderedLensKey = ''
let lastQueueKey = ''
let lastAllowlistKey = ''
let lastAuditKey = ''
let lastPairingKey = ''
let lastAnnounced = ''
let bridgeWriteQueue: Promise<unknown> = Promise.resolve()
let qrPollTimer: number | null = null

function stopQrPoll(): void {
  if (qrPollTimer !== null) {
    window.clearInterval(qrPollTimer)
    qrPollTimer = null
  }
}

// Official Even Hub protobuf envelope helper:
// CLICK_EVENT is 0, omitted on the wire; default MUST resolve inside the envelope check.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function announce(message: string): void {
  if (!message || message === lastAnnounced) return
  lastAnnounced = message
  const sr = el('sr-announce')
  if (sr) sr.textContent = message
}

// Uniformly scale the true 576x288 framebuffer inside .g2-viewport so mobile never wraps/reflows
function setupFramebufferScale(): void {
  const viewport = el('g2-viewport')
  const fb = el('g2-framebuffer')
  if (!viewport || !fb) return

  const updateScale = () => {
    const w = viewport.clientWidth
    if (w <= 0) return
    const scale = w / 576
    fb.style.transform = `scale(${scale})`
  }

  updateScale()
  const ro = new ResizeObserver(updateScale)
  ro.observe(viewport)
}

function pushFrameToG2(frame: G2Frame): void {
  const key = `${frame.body}\u0000${frame.footer}`
  if (key === lastRenderedLensKey) return
  lastRenderedLensKey = key

  const bodyEl = el('lens-body')
  const footerEl = el('lens-footer')
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

function updateHardwareStateChrome(): void {
  const pageRoot = el('page-root')
  const stepQueue = el('step-queue')
  const stepButtons = el('step-buttons')
  const stepGate = el('step-gate')
  const stepResult = el('step-result')
  const armStrip = el('arm-strip')
  const armLabel = el('arm-strip-label')
  const tapLabel = el('ring-tap-label')

  const isQueue =
    g2State.screen === 'queue' ||
    g2State.screen === 'empty' ||
    g2State.screen === 'loading' ||
    g2State.screen === 'offline' ||
    g2State.screen === 'unpaired'
  const isButtons = g2State.screen === 'buttons'
  const isDanger = g2State.screen === 'danger_confirm'
  const isRefusal = g2State.screen === 'refusal'
  const isGate = isDanger || isRefusal
  const isResult = g2State.screen === 'pressing' || g2State.screen === 'result'

  stepQueue?.setAttribute('data-active', String(isQueue))
  stepButtons?.setAttribute('data-active', String(isButtons))
  stepGate?.setAttribute('data-active', String(isGate && !isDanger))
  stepGate?.setAttribute('data-danger', String(isDanger))
  stepResult?.setAttribute('data-active', String(isResult))

  pageRoot?.setAttribute('data-arm', isDanger ? 'danger' : 'idle')

  if (tapLabel) {
    tapLabel.textContent = isDanger ? 'Confirm' : 'Tap'
  }

  if (armStrip && armLabel) {
    if (g2State.screen === 'danger_confirm') {
      const item = g2State.items[g2State.itemIndex]
      const btn = item?.buttons[g2State.buttonIndex]
      armStrip.hidden = false
      armLabel.textContent = btn ? `Armed: ${btn.label}, tap Confirm` : 'Destructive action armed'
      if (btn) announce(`${btn.label} armed, tap Confirm to execute`)
    } else {
      armStrip.hidden = true
    }
  }

  if (g2State.screen === 'refusal') {
    announce(`Blocked on glasses: ${g2State.headline}`)
  }
}

function renderTopStatus(): void {
  const readout = el('status-readout')
  const label = el('status-label')
  const dialogSpec = el('dialog-spec')

  if (!readout || !label) return
  if (!lastStatus) {
    readout.setAttribute('data-state', 'offline')
    label.textContent = 'Offline'
    if (dialogSpec) dialogSpec.textContent = 'Gateway offline'
  } else if (lastStatus.mode === 'demo') {
    readout.setAttribute('data-state', 'demo')
    label.textContent = 'Demo sandbox'
    if (dialogSpec) dialogSpec.textContent = 'Offline sandbox fixtures'
  } else if (lastStatus.pairing.status === 'paired') {
    readout.setAttribute('data-state', 'live')
    label.textContent = lastStatus.pairing.accountLabel || 'Live gateway'
    if (dialogSpec) dialogSpec.textContent = 'MTProto Layer 234 paired'
  } else {
    readout.setAttribute('data-state', 'offline')
    label.textContent = 'Unpaired'
    if (dialogSpec) dialogSpec.textContent = 'MTProto Layer 234 unpaired'
  }
}

function activeFocusedInfo(): { itemId: string | null; armedButtonB64: string | null } {
  if (g2State.screen === 'queue') {
    return { itemId: g2State.items[g2State.cursor]?.id ?? null, armedButtonB64: null }
  }
  if (g2State.screen === 'buttons') {
    return { itemId: g2State.items[g2State.itemIndex]?.id ?? null, armedButtonB64: null }
  }
  if (g2State.screen === 'danger_confirm') {
    const item = g2State.items[g2State.itemIndex]
    const btn = item?.buttons[g2State.buttonIndex]
    return { itemId: item?.id ?? null, armedButtonB64: btn?.dataB64 ?? null }
  }
  if (g2State.screen === 'pressing') {
    return { itemId: g2State.item.id, armedButtonB64: null }
  }
  return { itemId: null, armedButtonB64: null }
}

function renderQueuePanel(): void {
  const listEl = el<HTMLUListElement>('queue-list')
  const emptyEl = el('queue-empty')
  const tabCount = el('tab-count-queue')
  if (!listEl || !emptyEl) return

  if (tabCount) tabCount.textContent = String(lastItems.length)
  emptyEl.hidden = lastItems.length > 0

  const { itemId: focusedId, armedButtonB64 } = activeFocusedInfo()
  const now = Date.now()
  const queueKey = JSON.stringify({
    focusedId,
    armedButtonB64,
    items: lastItems.map((i) => [i.id, i.line, formatRelativeAge(i.sentAt, now), i.buttons.length]),
  })
  if (queueKey === lastQueueKey) return
  lastQueueKey = queueKey

  listEl.replaceChildren(
    ...lastItems.map((item, idx) => {
      const li = document.createElement('li')
      const isFocused = item.id === focusedId
      const isArmed = isFocused && armedButtonB64 !== null
      li.className = 'queue-row'
      li.dataset.focused = String(isFocused)
      li.dataset.armed = String(isArmed)

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'queue-row-btn'
      btn.addEventListener('click', () => {
        dispatch({ type: 'FOCUS_ITEM', index: idx, openButtons: true })
      })

      const head = document.createElement('div')
      head.className = 'queue-row-head'

      const botSpan = document.createElement('span')
      botSpan.className = 'queue-bot'
      botSpan.textContent = `@${item.bot}`

      const ageSpan = document.createElement('span')
      ageSpan.className = 'queue-age'
      ageSpan.textContent = formatRelativeAge(item.sentAt, now)

      head.append(botSpan, ageSpan)

      const lineP = document.createElement('p')
      lineP.className = 'queue-line'
      lineP.textContent = item.line

      const signals = document.createElement('div')
      signals.className = 'queue-signals'

      for (const cb of item.buttons) {
        const tag = document.createElement('span')
        const thisArmed = isArmed && cb.dataB64 === armedButtonB64
        tag.className = thisArmed
          ? 'signal-tag signal-tag--armed'
          : cb.requiresPassword
            ? 'signal-tag signal-tag--blocked'
            : cb.danger
              ? 'signal-tag signal-tag--danger'
              : 'signal-tag'
        tag.textContent = thisArmed
          ? `${cb.label}: Press again`
          : cb.requiresPassword
            ? `${cb.label} (2FA blocked)`
            : cb.danger
              ? `${cb.label} (2x tap)`
              : cb.label
        signals.append(tag)
      }

      if (item.hiddenNonCallbackCount > 0) {
        const stripped = document.createElement('span')
        stripped.className = 'signal-tag signal-tag--stripped'
        stripped.textContent = `${item.hiddenNonCallbackCount} non-callback stripped`
        signals.append(stripped)
      }

      btn.append(head, lineP, signals)
      li.append(btn)
      return li
    }),
  )
}

function renderAllowlistPanel(): void {
  const rowsEl = el<HTMLUListElement>('allowlist-rows')
  const tabCount = el('tab-count-allowlist')
  const modeNote = el('mode-note')
  const resetBtn = el<HTMLButtonElement>('btn-demo-reset')
  if (!rowsEl) return

  const allowlist = lastStatus?.allowlist ?? []
  if (tabCount) tabCount.textContent = String(allowlist.length)
  if (resetBtn) resetBtn.hidden = lastStatus?.mode !== 'demo'

  const allowKey = `${lastStatus?.mode ?? ''}|${lastStatus?.pairing.status ?? ''}|${allowlist.join(',')}`
  if (allowKey === lastAllowlistKey) return
  lastAllowlistKey = allowKey

  if (modeNote) {
    modeNote.textContent =
      lastStatus?.mode === 'demo'
        ? 'Offline sandbox fixtures active'
        : lastStatus?.pairing.status === 'paired'
          ? 'Live MTProto Layer 234'
          : ''
  }

  rowsEl.replaceChildren(
    ...allowlist.map((bot) => {
      const li = document.createElement('li')
      li.className = 'allowlist-item'

      const handle = document.createElement('span')
      handle.className = 'allowlist-handle'
      handle.textContent = `@${bot}`

      const rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'key key--quiet'
      rm.textContent = 'Remove'
      rm.addEventListener('click', async () => {
        await client.removeAllowlist(bot)
        await refreshFromGateway()
      })

      li.append(handle, rm)
      return li
    }),
  )
}

function renderAuditPanel(): void {
  const tbody = el<HTMLTableSectionElement>('audit-rows')
  const emptyEl = el('audit-empty')
  const tabCount = el('tab-count-audit')
  if (!tbody || !emptyEl) return

  const entries = lastStatus?.recentAudit.slice(0, 12) ?? []
  if (tabCount) tabCount.textContent = String(entries.length)
  emptyEl.hidden = entries.length > 0

  const auditKey = entries.map((e) => `${e.id}:${e.outcome}`).join('|')
  if (auditKey === lastAuditKey) return
  lastAuditKey = auditKey

  tbody.replaceChildren(
    ...entries.map((entry) => {
      const tr = document.createElement('tr')

      const tdAction = document.createElement('td')
      const botSpan = document.createElement('span')
      botSpan.className = 'audit-bot'
      botSpan.textContent = `@${entry.bot}`
      const lblSpan = document.createElement('span')
      lblSpan.className = 'audit-label'
      lblSpan.textContent = entry.buttonLabel
      tdAction.append(botSpan, lblSpan)

      const tdStatus = document.createElement('td')
      const stSpan = document.createElement('span')
      stSpan.className = 'audit-status'
      stSpan.dataset.outcome = entry.outcome
      stSpan.textContent = entry.outcome.replace(/_/g, ' ')
      tdStatus.append(stSpan)

      tr.append(tdAction, tdStatus)
      return tr
    }),
  )
}

function renderPairingModalState(): void {
  const statusText = el('pairing-status-text')
  const controls = el('pairing-controls')
  const feedback = el('pairing-feedback')
  const demoDetails = el('demo-env-details')
  if (!statusText || !controls) return

  const pairing = lastStatus?.pairing
  const pairingKey = pairing
    ? `${pairing.mode}|${pairing.status}|${pairing.hasApiCreds}|${pairing.accountLabel ?? ''}|${pairing.phoneMask ?? ''}|${pairing.qrUrl ?? ''}`
    : 'offline'

  if (!pairing) {
    statusText.textContent = 'Gateway unreachable. Test or update the endpoint URL above.'
    if (demoDetails) demoDetails.hidden = true
    if (pairingKey !== lastPairingKey) {
      lastPairingKey = pairingKey
      stopQrPoll()
      controls.replaceChildren()
    }
    return
  }

  if (pairing.mode === 'demo') {
    statusText.textContent = 'Connected to offline Demo Sandbox fixtures.'
    if (demoDetails) demoDetails.hidden = false
    if (pairingKey !== lastPairingKey) {
      lastPairingKey = pairingKey
      stopQrPoll()
      controls.replaceChildren()
    }
    return
  }

  if (demoDetails) demoDetails.hidden = true
  statusText.textContent =
    pairing.status === 'paired'
      ? `Paired as ${pairing.accountLabel || 'authorized account'}. Session stays on your gateway.`
      : `Live MTProto gateway (${pairing.status}). Session stays local to your gateway.`

  if (pairing.status === 'paired' || pairing.status === 'awaiting_2fa') {
    stopQrPoll()
  }

  if (pairingKey === lastPairingKey) {
    return
  }
  if (controls.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') {
    return
  }
  lastPairingKey = pairingKey

  const nodes: HTMLElement[] = []

  const row = document.createElement('div')
  row.className = 'dialog-row'

  const qrBtn = document.createElement('button')
  qrBtn.type = 'button'
  qrBtn.className = pairing.status === 'unpaired' ? 'key key--primary' : 'key'
  qrBtn.textContent = pairing.status === 'qr_pending' ? 'Refresh QR' : 'Start QR pairing'
  qrBtn.addEventListener('click', async () => {
    try {
      const res = await client.startQrPairing()
      if (feedback) {
        feedback.textContent = res.pairing.error || 'Scan QR in Telegram: Settings -> Devices -> Link Desktop Device.'
      }
      await refreshFromGateway()
      stopQrPoll()
      if (res.pairing.status === 'qr_pending') {
        qrPollTimer = window.setInterval(async () => {
          try {
            const polled = await client.pollQrPairing()
            if (polled.pairing.status === 'paired') {
              stopQrPoll()
              if (feedback) feedback.textContent = 'Paired.'
            } else if (polled.pairing.status === 'awaiting_2fa') {
              stopQrPoll()
              if (feedback) feedback.textContent = 'Enter your Telegram 2FA cloud password below.'
            }
            await refreshFromGateway()
          } catch {
            stopQrPoll()
          }
        }, 3000)
      }
    } catch (err) {
      if (feedback) feedback.textContent = err instanceof Error ? err.message : 'QR pairing failed'
    }
  })
  row.append(qrBtn)

  if (pairing.status === 'paired') {
    const signOut = document.createElement('button')
    signOut.type = 'button'
    signOut.className = 'key'
    signOut.textContent = 'Sign out'
    signOut.addEventListener('click', async () => {
      stopQrPoll()
      await client.disconnect()
      if (feedback) feedback.textContent = 'Session cleared on gateway.'
      await refreshFromGateway()
    })
    row.append(signOut)
  }
  nodes.push(row)

  if (pairing.qrUrl) {
    const qrPlate = document.createElement('div')
    qrPlate.className = 'qr-plate'

    const qrFrame = document.createElement('div')
    qrFrame.className = 'qr-frame'
    qrFrame.append(createQrSvgElement(pairing.qrUrl, 'Telegram QR login code'))

    const qrMeta = document.createElement('div')
    qrMeta.className = 'qr-meta'

    const steps = document.createElement('p')
    steps.className = 'qr-steps'
    steps.textContent = 'Open Telegram on your phone: Settings -> Devices -> Link Desktop Device.'

    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'key key--quiet'
    copyBtn.textContent = 'Copy tg:// link'
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pairing.qrUrl!)
        copyBtn.textContent = 'Copied'
        window.setTimeout(() => {
          copyBtn.textContent = 'Copy tg:// link'
        }, 1500)
      } catch {
        if (feedback) feedback.textContent = 'Copy failed; select the URI below.'
      }
    })

    const qrBox = document.createElement('div')
    qrBox.className = 'qr-readout'
    qrBox.textContent = pairing.qrUrl

    qrMeta.append(steps, copyBtn, qrBox)
    qrPlate.append(qrFrame, qrMeta)
    nodes.push(qrPlate)
  }

  if (pairing.status === 'unpaired') {
    const f = document.createElement('form')
    f.className = 'inline-form'
    const inp = document.createElement('input')
    inp.className = 'field'
    inp.type = 'tel'
    inp.placeholder = '+628…'
    inp.ariaLabel = 'Phone number'
    const btn = document.createElement('button')
    btn.type = 'submit'
    btn.className = 'key'
    btn.textContent = 'Send code'
    f.append(inp, btn)
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      if (!inp.value.trim()) return
      try {
        await client.startPhonePairing(inp.value.trim())
        if (feedback) feedback.textContent = 'Code sent to your Telegram app.'
        await refreshFromGateway()
      } catch (err) {
        if (feedback) feedback.textContent = err instanceof Error ? err.message : 'Send code failed'
      }
    })
    nodes.push(f)
  }

  if (pairing.status === 'awaiting_code') {
    const f = document.createElement('form')
    f.className = 'inline-form'
    const inp = document.createElement('input')
    inp.className = 'field'
    inp.type = 'text'
    inp.placeholder = `Login code (${pairing.phoneMask ?? ''})`
    inp.ariaLabel = 'Telegram login code'
    const btn = document.createElement('button')
    btn.type = 'submit'
    btn.className = 'key key--primary'
    btn.textContent = 'Verify code'
    f.append(inp, btn)
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      if (!inp.value.trim()) return
      try {
        await client.submitPhoneCode(inp.value.trim())
        if (feedback) feedback.textContent = ''
        await refreshFromGateway()
      } catch (err) {
        if (feedback) feedback.textContent = err instanceof Error ? err.message : 'Verification failed'
      }
    })
    nodes.push(f)
  }

  if (pairing.status === 'awaiting_2fa') {
    const f = document.createElement('form')
    f.className = 'inline-form'
    const inp = document.createElement('input')
    inp.className = 'field'
    inp.type = 'password'
    inp.placeholder = 'Telegram 2FA password'
    inp.ariaLabel = 'Telegram 2FA cloud password'
    const btn = document.createElement('button')
    btn.type = 'submit'
    btn.className = 'key key--primary'
    btn.textContent = 'Unlock'
    f.append(inp, btn)
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      if (!inp.value) return
      try {
        await client.submit2FA(inp.value)
        if (feedback) feedback.textContent = ''
        await refreshFromGateway()
      } catch (err) {
        if (feedback) feedback.textContent = err instanceof Error ? err.message : '2FA unlock failed'
      }
    })
    nodes.push(f)
  }

  controls.replaceChildren(...nodes)
}

function syncUI(): void {
  const frame = renderG2Frame(g2State, Date.now())
  pushFrameToG2(frame)
  updateHardwareStateChrome()
  renderTopStatus()
  renderQueuePanel()
  renderAllowlistPanel()
  renderAuditPanel()
  renderPairingModalState()
}

function dispatch(action: G2Action): void {
  const { state, effect } = reduceG2State(g2State, action, lastMeta)
  g2State = state
  syncUI()

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
    lastItems = pending.items
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
    lastItems = []
    dispatch({
      type: 'SYNC_ERROR',
      message: err instanceof Error ? err.message : 'Gateway unreachable',
    })
  }
}

// Accessible tabs (selection follows focus, focusgroupstart sync, beforematch for hidden="until-found")
function setupTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#tablist [role="tab"]'))
  const panelMap: Record<string, HTMLElement | null> = {
    'tab-queue': el('panel-queue'),
    'tab-allowlist': el('panel-allowlist'),
    'tab-audit': el('panel-audit'),
  }

  const selectTab = (target: HTMLButtonElement) => {
    for (const tab of tabs) {
      const selected = tab === target
      tab.setAttribute('aria-selected', String(selected))
      tab.toggleAttribute('focusgroupstart', selected)
      const panel = panelMap[tab.id]
      if (panel) {
        if (selected) {
          panel.removeAttribute('hidden')
          panel.setAttribute('tabindex', '0')
        } else {
          panel.setAttribute('hidden', 'until-found')
          panel.removeAttribute('tabindex')
        }
      }
    }
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab))
    tab.addEventListener('keydown', (ev) => {
      const idx = tabs.indexOf(tab)
      if (ev.key === 'ArrowRight') {
        ev.preventDefault()
        const next = tabs[(idx + 1) % tabs.length]!
        next.focus()
        selectTab(next)
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault()
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length]!
        prev.focus()
        selectTab(prev)
      }
    })
  }

  for (const [tabId, panel] of Object.entries(panelMap)) {
    panel?.addEventListener('beforematch', () => {
      const t = tabs.find((x) => x.id === tabId)
      if (t) selectTab(t)
    })
  }
}

// Native modal <dialog> wiring (modern-web-guidance: showModal, reset returnValue, closedby fallback)
function setupGatewayDialog(): void {
  const dialog = el<HTMLDialogElement>('gateway-dialog')
  const openBtn = el('btn-open-gateway')
  const closeBtn = el('btn-close-gateway')
  const testBtn = el('btn-test-gateway')
  const pingOut = el<HTMLOutputElement>('gateway-ping')
  const urlInput = el<HTMLInputElement>('input-url')
  const tokenInput = el<HTMLInputElement>('input-token')
  if (!dialog) return

  const syncInputs = () => {
    const cfg = client.getConfig()
    if (urlInput) urlInput.value = cfg.baseUrl
    if (tokenInput) tokenInput.value = cfg.token ?? ''
    if (pingOut) {
      pingOut.textContent = ''
      pingOut.removeAttribute('data-ok')
    }
  }

  openBtn?.addEventListener('click', () => {
    syncInputs()
    dialog.showModal()
  })

  closeBtn?.addEventListener('click', () => {
    dialog.close('close')
  })

  dialog.addEventListener('close', () => {
    dialog.returnValue = ''
    stopQrPoll()
  })

  testBtn?.addEventListener('click', async () => {
    const base = (urlInput?.value.trim() || client.getConfig().baseUrl).replace(/\/+$/, '')
    const t0 = performance.now()
    if (pingOut) {
      pingOut.textContent = 'testing…'
      pingOut.removeAttribute('data-ok')
    }
    try {
      const res = await fetch(`${base}/health`)
      const ms = Math.round(performance.now() - t0)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { mode?: string }
      if (pingOut) {
        pingOut.dataset.ok = 'true'
        pingOut.textContent = `ok (${body.mode ?? 'live'}, ${ms}ms)`
      }
    } catch (err) {
      if (pingOut) {
        pingOut.dataset.ok = 'false'
        pingOut.textContent = err instanceof Error ? err.message : 'unreachable'
      }
    }
  })

  // Graceful light-dismiss fallback when browser lacks native closedby="any"
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }
    let pressedOutside = false
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e)
    })
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e)) dialog.close('backdrop')
    })
  }

  el('form-gateway')?.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const url = urlInput?.value.trim()
    const tok = tokenInput?.value.trim() ?? ''
    if (!url) return
    window.localStorage.setItem(STORAGE_URL_KEY, url)
    window.localStorage.setItem(STORAGE_TOKEN_KEY, tok)
    client.configure({ baseUrl: url, token: tok })
    dialog.close('saved')
    void refreshFromGateway()
  })
}

function setupControls(): void {
  el('ring-up')?.addEventListener('click', () => dispatch({ type: 'SCROLL_UP' }))
  el('ring-down')?.addEventListener('click', () => dispatch({ type: 'SCROLL_DOWN' }))
  el('ring-tap')?.addEventListener('click', () => dispatch({ type: 'TAP', now: Date.now() }))
  el('ring-double')?.addEventListener('click', () => dispatch({ type: 'DOUBLE_TAP' }))
  el('btn-sync')?.addEventListener('click', () => void refreshFromGateway())

  el('btn-demo-reset')?.addEventListener('click', async () => {
    await client.resetDemo()
    await refreshFromGateway()
  })

  el('form-allowlist')?.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const input = el<HTMLInputElement>('input-bot')
    const hint = el('allowlist-hint')
    const val = input?.value.trim()
    if (!val) return
    try {
      await client.addAllowlist(val)
      if (input) input.value = ''
      if (hint) {
        hint.dataset.error = 'false'
        hint.textContent = 'Bot added to allowlist.'
      }
      await refreshFromGateway()
    } catch (err) {
      if (hint) {
        hint.dataset.error = 'true'
        hint.textContent = err instanceof Error ? err.message : 'Invalid bot handle'
      }
    }
  })

  window.addEventListener('keydown', (ev) => {
    const dialog = el<HTMLDialogElement>('gateway-dialog')
    if (dialog?.open) return
    if (
      ev.target instanceof HTMLInputElement ||
      ev.target instanceof HTMLTextAreaElement ||
      (ev.target instanceof HTMLElement && ev.target.closest('#tablist'))
    ) {
      return
    }
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
      height: 240,
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
      yPosition: 244,
      width: 576,
      height: 44,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 2,
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
      lastRenderedLensKey = `${initialFrame.body}\u0000${initialFrame.footer}`
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
    console.warn('[bottap] Even Hub bridge not active (standalone browser mode):', err)
  }
}

setupFramebufferScale()
setupTabs()
setupGatewayDialog()
setupControls()
syncUI()
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
