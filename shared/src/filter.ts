import type { ButtonStyleKind, CallbackButton, DangerSource, QueueItem } from './protocol.js'

export const MAX_ALERT_LINE_CHARS = 40
export const MAX_BUTTON_LABEL_CHARS = 22
export const MAX_CALLBACK_DATA_BYTES = 64
export const MAX_BUTTONS_PER_ITEM = 6
export const DEFAULT_MAX_ALERT_AGE_MS = 48 * 60 * 60 * 1000

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
  readonly chatPeer?: string
  readonly chatTitle?: string
  readonly msgId: number
  readonly rawText: string
  readonly sentAt: number
  readonly buttons: readonly RawInlineButton[]
}

const HANDLE_RE = /^[a-z0-9_]{3,64}$/
const NUMERIC_GROUP_RE = /^-?\d{5,20}$/

// Conservative lexical danger floor for third-party bots that do not yet emit Telegram bgDanger style
const CONSERVATIVE_DANGER_RE =
  /\b(approve|deploy|delete|drop|destroy|rollback|restart|rotate|revoke|transfer|withdraw|wipe|terminate|kill|prod|production|mainnet)\b/i

const ALLOWED_CALLBACK_TYPES = new Set([
  'InlineButtonTypeCallback', // Telegram MTProto Layer 234 (KeyboardInlineButton.type)
  'KeyboardButtonCallback', // Legacy MTProto Layer <= 233 & test fixtures
])

export function normalizeBotHandle(raw: string): string | null {
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase()
  if (!HANDLE_RE.test(cleaned)) return null
  return cleaned
}

export function normalizeChatPeer(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (NUMERIC_GROUP_RE.test(trimmed)) return trimmed
  return normalizeBotHandle(trimmed)
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

export function normalizeGroupAllowlist(rawList: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of rawList) {
    const norm = normalizeChatPeer(entry)
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

export function isGroupAllowlisted(chatPeer: string, groups: readonly string[]): boolean {
  const norm = normalizeChatPeer(chatPeer)
  if (!norm) return false
  for (const allowed of groups) {
    if (normalizeChatPeer(allowed) === norm) return true
  }
  return false
}

export function stripControlChars(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u200D\uFE0E\uFE0F\uFEFF]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
}

function truncateCodePoints(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  if (maxChars <= 3) return chars.slice(0, maxChars).join('')
  return chars.slice(0, maxChars - 3).join('').trimEnd() + '...'
}

export function sanitizeAlertLine(rawMessage: string, maxChars = MAX_ALERT_LINE_CHARS): string {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) =>
      stripControlChars(line)
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/[`~]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)

  const informative = lines.find((line) => /[a-z0-9]{2}/i.test(line)) ?? lines[0] ?? 'Pending bot action'
  return truncateCodePoints(informative, maxChars)
}

export function sanitizeButtonLabel(rawLabel: string, maxChars = MAX_BUTTON_LABEL_CHARS): string {
  const clean = stripControlChars(rawLabel).replace(/\s+/g, ' ').trim()
  if (!clean) return 'Action'
  return truncateCodePoints(clean, maxChars)
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

export function classifyInlineButton(
  raw: RawInlineButton,
  options: { readonly forceConfirm?: boolean } = {},
): CallbackButton | null {
  // Strictly allow callback buttons only; drop url, web_app, game, buy, switch_inline, copy, disabled, etc.
  if (!ALLOWED_CALLBACK_TYPES.has(raw.typeName)) {
    return null
  }
  const dataB64 = encodeCallbackData(raw.data)
  if (!dataB64) return null

  const label = sanitizeButtonLabel(raw.text)
  const protocolDanger = Boolean(raw.style?.bgDanger)
  const policyDanger = !protocolDanger && (Boolean(options.forceConfirm) || CONSERVATIVE_DANGER_RE.test(label))
  const danger = protocolDanger || policyDanger
  const dangerSource: DangerSource | undefined = protocolDanger
    ? 'protocol'
    : policyDanger
      ? 'policy'
      : undefined

  const style: ButtonStyleKind = protocolDanger
    ? 'danger'
    : raw.style?.bgPrimary
      ? 'primary'
      : raw.style?.bgSuccess
        ? 'success'
        : policyDanger
          ? 'danger'
          : 'default'

  return {
    kind: 'callback',
    label,
    dataB64,
    danger,
    dangerSource,
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

  const chatPeer = normalizeChatPeer(raw.chatPeer ?? '') ?? bot
  const callbacks: CallbackButton[] = []
  let hiddenNonCallbackCount = 0
  let hiddenOverflowCount = 0

  for (const btn of raw.buttons) {
    const classified = classifyInlineButton(btn)
    if (!classified) {
      hiddenNonCallbackCount += 1
      continue
    }
    if (callbacks.length < MAX_BUTTONS_PER_ITEM) {
      callbacks.push(classified)
    } else {
      hiddenOverflowCount += 1
    }
  }

  if (callbacks.length === 0) {
    return null
  }

  return {
    id: `${chatPeer}:${raw.msgId}`,
    bot,
    botTitle: sanitizeButtonLabel(raw.botTitle || `@${bot}`, 24),
    chatPeer,
    chatTitle: raw.chatTitle ? sanitizeButtonLabel(raw.chatTitle, 24) : undefined,
    msgId: raw.msgId,
    line: sanitizeAlertLine(raw.rawText, MAX_ALERT_LINE_CHARS),
    sentAt: raw.sentAt,
    buttons: callbacks,
    hiddenNonCallbackCount,
    hiddenOverflowCount,
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
