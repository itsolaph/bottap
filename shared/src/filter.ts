import type { ButtonStyleKind, CallbackButton, QueueItem } from './protocol.js'

export const MAX_ALERT_LINE_CHARS = 40
export const MAX_BUTTON_LABEL_CHARS = 22
export const MAX_CALLBACK_DATA_BYTES = 64
export const MAX_BUTTONS_PER_ITEM = 6

export interface RawInlineButtonStyle {
  readonly bgDanger?: boolean
  readonly bgPrimary?: boolean
  readonly bgSuccess?: boolean
}

export interface RawInlineButton {
  readonly typeName: string
  readonly text: string
  readonly data?: Uint8Array | string
  readonly requiresPassword?: boolean
  readonly style?: RawInlineButtonStyle
}

export interface RawBotMessage {
  readonly botHandle: string
  readonly botTitle: string
  readonly msgId: number
  readonly rawText: string
  readonly sentAt: number
  readonly buttons: readonly RawInlineButton[]
}

const HANDLE_RE = /^[a-z0-9_]{3,64}$/

export function normalizeBotHandle(raw: string): string | null {
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase()
  if (!HANDLE_RE.test(cleaned)) return null
  return cleaned
}

export function normalizeAllowlist(rawList: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of rawList) {
    const norm = normalizeBotHandle(entry)
    if (norm && !seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

export function isAllowlisted(botHandle: string, allowlist: readonly string[]): boolean {
  const norm = normalizeBotHandle(botHandle)
  if (!norm) return false
  for (const allowed of allowlist) {
    if (normalizeBotHandle(allowed) === norm) return true
  }
  return false
}

export function stripControlChars(input: string): string {
  return input.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/g, ' ')
}

export function sanitizeAlertLine(rawMessage: string, maxChars = MAX_ALERT_LINE_CHARS): string {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) =>
      stripControlChars(line)
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/[`*_~#>]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)

  const first = lines[0] ?? 'Pending bot action'
  if (first.length <= maxChars) return first
  if (maxChars <= 3) return first.slice(0, maxChars)
  return first.slice(0, maxChars - 3).trimEnd() + '...'
}

export function sanitizeButtonLabel(rawLabel: string, maxChars = MAX_BUTTON_LABEL_CHARS): string {
  const clean = stripControlChars(rawLabel).replace(/\s+/g, ' ').trim()
  if (!clean) return 'Action'
  if (clean.length <= maxChars) return clean
  if (maxChars <= 3) return clean.slice(0, maxChars)
  return clean.slice(0, maxChars - 3).trimEnd() + '...'
}

function encodeCallbackData(data: Uint8Array | string | undefined): string | null {
  if (data === undefined) return null
  let bytes: Uint8Array
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data)
  } else {
    bytes = data
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CALLBACK_DATA_BYTES) {
    return null
  }
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

export function decodeBase64ToBytes(b64: string): Uint8Array | null {
  if (!b64 || typeof b64 !== 'string') return null
  try {
    const binary = atob(b64)
    if (binary.length === 0 || binary.length > MAX_CALLBACK_DATA_BYTES) return null
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

export function classifyInlineButton(raw: RawInlineButton): CallbackButton | null {
  // Strictly allow KeyboardButtonCallback only; drop url, web_app, game, buy, switch_inline, copy, etc.
  if (raw.typeName !== 'KeyboardButtonCallback') {
    return null
  }
  const dataB64 = encodeCallbackData(raw.data)
  if (!dataB64) return null

  const danger = Boolean(raw.style?.bgDanger)
  const style: ButtonStyleKind = danger
    ? 'danger'
    : raw.style?.bgPrimary
      ? 'primary'
      : raw.style?.bgSuccess
        ? 'success'
        : 'default'

  return {
    kind: 'callback',
    label: sanitizeButtonLabel(raw.text),
    dataB64,
    danger,
    requiresPassword: Boolean(raw.requiresPassword),
    style,
  }
}

export function buildQueueItem(
  raw: RawBotMessage,
  allowlist: readonly string[],
): QueueItem | null {
  const bot = normalizeBotHandle(raw.botHandle)
  if (!bot || !isAllowlisted(bot, allowlist)) {
    return null
  }
  if (!Number.isInteger(raw.msgId) || raw.msgId <= 0) {
    return null
  }

  const callbacks: CallbackButton[] = []
  let hiddenNonCallbackCount = 0

  for (const btn of raw.buttons) {
    const classified = classifyInlineButton(btn)
    if (!classified) {
      hiddenNonCallbackCount += 1
      continue
    }
    if (callbacks.length < MAX_BUTTONS_PER_ITEM) {
      callbacks.push(classified)
    }
  }

  if (callbacks.length === 0) {
    return null
  }

  return {
    id: `${bot}:${raw.msgId}`,
    bot,
    botTitle: sanitizeButtonLabel(raw.botTitle || `@${bot}`, 24),
    msgId: raw.msgId,
    line: sanitizeAlertLine(raw.rawText, MAX_ALERT_LINE_CHARS),
    sentAt: raw.sentAt,
    buttons: callbacks,
    hiddenNonCallbackCount,
  }
}

export function formatRelativeAge(sentAtMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - sentAtMs) / 1000))
  if (diffSec < 60) return 'now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d`
}
