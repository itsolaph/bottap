import { TelegramClient, Api, sessions, password as tgPassword } from 'teleproto'
import {
  DEFAULT_MAX_ALERT_AGE_MS,
  isAllowlisted,
  normalizeBotHandle,
  normalizeChatPeer,
  type PairingState,
  type RawBotMessage,
  type RawInlineButton,
  type ScanDiagnostic,
} from '@bottap/shared'
import type { GatewayStore } from './store.js'
import type { BotTransport, CallbackPressResult, ScanResult } from './transport.js'

const { StringSession } = sessions

export interface MtprotoConfig {
  readonly apiId: number
  readonly apiHash: string
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.length <= 5) return '***'
  return `${digits.slice(0, 3)}***${digits.slice(-3)}`
}

function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function summarizeMtprotoError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const flood = /FLOOD_WAIT_(\d+)/i.exec(msg)
  if (flood) return `Telegram flood wait (${flood[1]}s)`
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|Cannot find any entity/i.test(msg)) {
    return 'Bot/group not found or never /started'
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/i.test(msg)) {
    return 'Telegram session expired — re-pair'
  }
  if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/i.test(msg)) {
    return 'No access to target chat'
  }
  return 'Unreachable (check handle or Telegram session)'
}

/**
 * Extracts inline keyboard buttons from Telegram MTProto Layer 234 (`KeyboardInlineButton`
 * with typed `.type = InlineButtonTypeCallback | InlineButtonTypeUrl | ...` and
 * `.style = KeyboardButtonStyle`) while remaining backward-compatible with legacy Layer <=233
 * `KeyboardButtonCallback` constructors.
 */
export function extractInlineButtons(markup: unknown): RawInlineButton[] {
  if (!markup || typeof markup !== 'object') return []
  const m = markup as { className?: string; rows?: Array<{ buttons?: unknown[] }> }
  if (m.className !== 'ReplyInlineMarkup' || !Array.isArray(m.rows)) return []

  const out: RawInlineButton[] = []
  for (const row of m.rows) {
    if (!Array.isArray(row?.buttons)) continue
    for (const rawBtn of row.buttons) {
      if (!rawBtn || typeof rawBtn !== 'object') continue
      const b = rawBtn as {
        className?: string
        text?: string
        data?: Uint8Array | Buffer
        requiresPassword?: boolean
        type?: {
          className?: string
          data?: Uint8Array | Buffer
          requiresPassword?: boolean
        }
        style?: {
          bgDanger?: boolean
          bgPrimary?: boolean
          bgSuccess?: boolean
        }
      }

      const isLayer234 = b.className === 'KeyboardInlineButton' && b.type && typeof b.type === 'object'
      const typeName = isLayer234 ? b.type!.className ?? 'UnknownInlineButtonType' : b.className ?? 'UnknownButton'
      const rawData = isLayer234 ? b.type!.data : b.data
      const requiresPassword = isLayer234 ? Boolean(b.type!.requiresPassword) : Boolean(b.requiresPassword)

      out.push({
        typeName,
        text: typeof b.text === 'string' ? b.text : '',
        data: rawData instanceof Uint8Array ? new Uint8Array(rawData) : undefined,
        requiresPassword,
        style: b.style
          ? {
              bgDanger: Boolean(b.style.bgDanger),
              bgPrimary: Boolean(b.style.bgPrimary),
              bgSuccess: Boolean(b.style.bgSuccess),
            }
          : undefined,
      })
    }
  }
  return out
}

interface CachedEntity {
  readonly entity: unknown
  readonly title: string
  readonly isBot: boolean
  readonly cachedAt: number
}

export class MtprotoBotTransport implements BotTransport {
  readonly mode = 'live' as const
  private client: TelegramClient | null = null
  private pairingState: PairingState
  private pendingPhone: { phoneNumber: string; phoneCodeHash: string } | null = null
  private entityCache = new Map<string, CachedEntity>()
  private scanCache: { key: string; at: number; result: ScanResult } | null = null
  private scanInFlight: { key: string; promise: Promise<ScanResult> } | null = null
  private authFailures = 0
  private authLockedUntil = 0

  constructor(
    private readonly config: MtprotoConfig,
    private readonly store: GatewayStore,
  ) {
    const hasApiCreds = Number.isInteger(config.apiId) && config.apiId > 0 && config.apiHash.length > 0
    this.pairingState = {
      status: 'unpaired',
      mode: 'live',
      hasApiCreds,
    }
  }

  private assertCreds(): void {
    if (!this.pairingState.hasApiCreds) {
      throw new Error('Set TG_API_ID and TG_API_HASH in .env before pairing')
    }
  }

  private async ensureClient(): Promise<TelegramClient> {
    this.assertCreds()
    if (this.client) {
      if (!this.client.connected) {
        await this.client.connect()
      }
      return this.client
    }
    const saved = this.store.loadSessionString()
    const client = new TelegramClient(new StringSession(saved), this.config.apiId, this.config.apiHash, {
      connectionRetries: 5,
    })
    await client.connect()
    this.client = client
    return client
  }

  private async refreshAuthorizedProfile(client: TelegramClient): Promise<PairingState> {
    const me = (await client.getMe()) as { username?: string; firstName?: string; id?: unknown } | null
    if (!me) {
      this.pairingState = {
        status: 'unpaired',
        mode: 'live',
        hasApiCreds: this.pairingState.hasApiCreds,
      }
      return this.pairingState
    }
    const savedSession = String(client.session.save() ?? '')
    if (savedSession) {
      this.store.saveSessionString(savedSession)
    }
    const label = me.username ? `@${me.username}` : me.firstName || 'paired account'
    this.pendingPhone = null
    this.pairingState = {
      status: 'paired',
      mode: 'live',
      hasApiCreds: true,
      accountLabel: label,
    }
    return this.pairingState
  }

  async init(): Promise<void> {
    if (!this.pairingState.hasApiCreds) return
    const saved = this.store.loadSessionString()
    if (!saved) return
    try {
      const client = await this.ensureClient()
      const authorized = await client.isUserAuthorized()
      if (authorized) {
        await this.refreshAuthorizedProfile(client)
      }
    } catch (err) {
      this.pairingState = {
        status: 'unpaired',
        mode: 'live',
        hasApiCreds: true,
        error: err instanceof Error ? err.message : 'Failed to restore MTProto session',
      }
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect()
      } catch {
        // Ignore shutdown disconnect errors
      }
      this.client = null
    }
  }

  getPairingState(): PairingState {
    return { ...this.pairingState }
  }

  async startQrPairing(): Promise<PairingState> {
    const client = await this.ensureClient()
    if (await client.isUserAuthorized()) {
      return this.refreshAuthorizedProfile(client)
    }
    return this.exportOrAcceptLoginToken(client, true)
  }

  async pollQrPairing(): Promise<PairingState> {
    const client = await this.ensureClient()
    if (await client.isUserAuthorized()) {
      return this.refreshAuthorizedProfile(client)
    }
    // Re-export login token to check acceptance, but preserve current QR URL when token is unchanged
    return this.exportOrAcceptLoginToken(client, false)
  }

  private async exportOrAcceptLoginToken(
    client: TelegramClient,
    forceFresh: boolean,
  ): Promise<PairingState> {
    try {
      const res = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: this.config.apiId,
          apiHash: this.config.apiHash,
          exceptIds: [],
        }),
      )

      if (res instanceof Api.auth.LoginTokenSuccess) {
        return this.refreshAuthorizedProfile(client)
      }
      if (res instanceof Api.auth.LoginTokenMigrateTo) {
        await client._switchDC(res.dcId)
        const imported = await client.invoke(
          new Api.auth.ImportLoginToken({ token: res.token }),
        )
        if (imported instanceof Api.auth.LoginTokenSuccess) {
          return this.refreshAuthorizedProfile(client)
        }
      }
      if (res instanceof Api.auth.LoginToken) {
        const tokenB64Url = toBase64Url(res.token)
        const qrUrl = `tg://login?token=${tokenB64Url}`
        const expiresAt = res.expires * 1000
        // Keep existing qrUrl stable while scanning unless expired or forced
        const keepCurrent =
          !forceFresh &&
          this.pairingState.status === 'qr_pending' &&
          this.pairingState.qrUrl &&
          this.pairingState.qrExpiresAt &&
          Date.now() < this.pairingState.qrExpiresAt - 4000
        this.pairingState = {
          status: 'qr_pending',
          mode: 'live',
          hasApiCreds: true,
          qrUrl: keepCurrent ? this.pairingState.qrUrl : qrUrl,
          qrExpiresAt: keepCurrent ? this.pairingState.qrExpiresAt : expiresAt,
        }
        return this.getPairingState()
      }
      return this.getPairingState()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        this.pairingState = {
          status: 'awaiting_2fa',
          mode: 'live',
          hasApiCreds: true,
        }
        return this.getPairingState()
      }
      this.pairingState = {
        status: 'unpaired',
        mode: 'live',
        hasApiCreds: true,
        error: summarizeMtprotoError(err),
      }
      return this.getPairingState()
    }
  }

  async startPhonePairing(phoneNumber: string): Promise<PairingState> {
    const cleaned = phoneNumber.trim()
    if (!cleaned) throw new Error('Phone number is required')
    const client = await this.ensureClient()
    const sent = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: cleaned,
        apiId: this.config.apiId,
        apiHash: this.config.apiHash,
        settings: new Api.CodeSettings({}),
      }),
    )
    const phoneCodeHash = (sent as { phoneCodeHash?: string }).phoneCodeHash
    if (!phoneCodeHash) {
      throw new Error('Telegram did not return a phoneCodeHash')
    }
    this.pendingPhone = { phoneNumber: cleaned, phoneCodeHash }
    this.pairingState = {
      status: 'awaiting_code',
      mode: 'live',
      hasApiCreds: true,
      phoneMask: maskPhone(cleaned),
    }
    return this.getPairingState()
  }

  private assertNotLocked(): void {
    if (Date.now() < this.authLockedUntil) {
      throw new Error('Too many failed verification attempts; wait 60 seconds before retrying')
    }
  }

  private recordAuthFailure(): void {
    this.authFailures += 1
    if (this.authFailures >= 5) {
      this.authLockedUntil = Date.now() + 60_000
      this.authFailures = 0
    }
  }

  private resetAuthFailures(): void {
    this.authFailures = 0
    this.authLockedUntil = 0
  }

  async submitPhoneCode(code: string): Promise<PairingState> {
    this.assertNotLocked()
    if (this.pairingState.status !== 'awaiting_code' || !this.pendingPhone) {
      throw new Error('Start phone pairing first')
    }
    const client = await this.ensureClient()
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.pendingPhone.phoneNumber,
          phoneCodeHash: this.pendingPhone.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      )
      this.resetAuthFailures()
      return this.refreshAuthorizedProfile(client)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        this.resetAuthFailures()
        this.pairingState = {
          status: 'awaiting_2fa',
          mode: 'live',
          hasApiCreds: true,
          phoneMask: maskPhone(this.pendingPhone.phoneNumber),
        }
        return this.getPairingState()
      }
      this.recordAuthFailure()
      throw new Error('Invalid login code')
    }
  }

  async submit2FAPassword(password: string): Promise<PairingState> {
    this.assertNotLocked()
    if (this.pairingState.status !== 'awaiting_2fa') {
      throw new Error('2FA verification is not active')
    }
    const client = await this.ensureClient()
    try {
      const srpParams = await client.invoke(new Api.account.GetPassword())
      const check = await tgPassword.computeCheck(srpParams, password)
      await client.invoke(new Api.auth.CheckPassword({ password: check }))
      this.resetAuthFailures()
      return this.refreshAuthorizedProfile(client)
    } catch {
      this.recordAuthFailure()
      throw new Error('Invalid 2FA password')
    }
  }

  async disconnect(): Promise<PairingState> {
    if (this.client) {
      try {
        if (await this.client.isUserAuthorized()) {
          await this.client.invoke(new Api.auth.LogOut())
        }
      } catch {
        // Proceed with local session wipe regardless
      }
      await this.close()
    }
    this.store.clearSessionString()
    this.entityCache.clear()
    this.scanCache = null
    this.scanInFlight = null
    this.pendingPhone = null
    this.pairingState = {
      status: 'unpaired',
      mode: 'live',
      hasApiCreds: this.pairingState.hasApiCreds,
    }
    return this.getPairingState()
  }

  private async resolveEntity(
    client: TelegramClient,
    peerKey: string,
    requireBot: boolean,
  ): Promise<CachedEntity> {
    const norm = normalizeChatPeer(peerKey)
    if (!norm) throw new Error('Invalid peer identifier')
    const cached = this.entityCache.get(norm)
    if (cached && Date.now() - cached.cachedAt < 30 * 60_000) {
      if (requireBot && !cached.isBot) {
        throw new Error(`@${norm} is not a Telegram bot account`)
      }
      return cached
    }
    const target: Api.TypeEntityLike = /^-?\d+$/.test(norm) ? Number(norm) : norm
    const entity = await client.getEntity(target)
    const e = entity as { firstName?: string; title?: string; username?: string; bot?: boolean }
    const isBot = Boolean(e.bot)
    if (requireBot && !isBot) {
      throw new Error(`@${norm} is not a Telegram bot account`)
    }
    const title = e.title || e.firstName || (e.username ? `@${e.username}` : norm)
    const record: CachedEntity = { entity, title, isBot, cachedAt: Date.now() }
    this.entityCache.set(norm, record)
    return record
  }

  async scanPending(
    allowlist: readonly string[],
    groups: readonly string[] = [],
  ): Promise<ScanResult> {
    if (this.pairingState.status !== 'paired' || !this.client) {
      return { items: [], diagnostics: [] }
    }
    const botsKey = allowlist.map((h) => normalizeBotHandle(h)).filter(Boolean).sort().join(',')
    const groupsKey = groups.map((g) => normalizeChatPeer(g)).filter(Boolean).sort().join(',')
    const key = `${botsKey}|${groupsKey}`
    const now = Date.now()
    if (this.scanCache && this.scanCache.key === key && now - this.scanCache.at < 1500) {
      return this.scanCache.result
    }
    if (this.scanInFlight && this.scanInFlight.key === key) {
      return this.scanInFlight.promise
    }

    const work = (async (): Promise<ScanResult> => {
      const client = await this.ensureClient()
      const results: RawBotMessage[] = []
      const diagnostics: ScanDiagnostic[] = []
      const cutoffMs = Date.now() - DEFAULT_MAX_ALERT_AGE_MS

      // 1. Direct bot DM threads (verified bot entities only)
      for (const handle of allowlist) {
        const norm = normalizeBotHandle(handle)
        if (!norm) continue
        try {
          const { entity, title } = await this.resolveEntity(client, norm, true)
          const messages = await client.getMessages(entity as Api.TypeEntityLike, { limit: 24 })
          for (const msg of messages) {
            if (msg.out) continue
            const sentAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()
            if (sentAt < cutoffMs) continue
            const buttons = extractInlineButtons(msg.replyMarkup)
            if (buttons.length === 0) continue
            const rawText = typeof msg.message === 'string' ? msg.message : ''
            results.push({
              botHandle: norm,
              botTitle: title,
              chatPeer: norm,
              msgId: msg.id,
              rawText,
              sentAt,
              buttons,
            })
          }
        } catch (err) {
          const msg = err instanceof Error && err.message.includes('not a Telegram bot')
            ? err.message
            : summarizeMtprotoError(err)
          diagnostics.push({ target: `@${norm}`, error: msg })
        }
      }

      // 2. Allowlisted ops groups (strictly messages authored by allowlisted bots)
      for (const groupPeer of groups) {
        const normGroup = normalizeChatPeer(groupPeer)
        if (!normGroup) continue
        try {
          const { entity: groupEntity, title: groupTitle } = await this.resolveEntity(
            client,
            normGroup,
            false,
          )
          const messages = await client.getMessages(groupEntity as Api.TypeEntityLike, { limit: 30 })
          for (const msg of messages) {
            const sentAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()
            if (sentAt < cutoffMs) continue
            const buttons = extractInlineButtons(msg.replyMarkup)
            if (buttons.length === 0) continue
            const sender = (await msg.getSender?.()) as {
              bot?: boolean
              username?: string
              firstName?: string
            } | null
            if (!sender?.bot || !sender.username) continue
            const senderBot = normalizeBotHandle(sender.username)
            if (!senderBot || !isAllowlisted(senderBot, allowlist)) continue
            const rawText = typeof msg.message === 'string' ? msg.message : ''
            results.push({
              botHandle: senderBot,
              botTitle: sender.firstName || `@${senderBot}`,
              chatPeer: normGroup,
              chatTitle: groupTitle,
              msgId: msg.id,
              rawText,
              sentAt,
              buttons,
            })
          }
        } catch (err) {
          diagnostics.push({ target: normGroup, error: summarizeMtprotoError(err) })
        }
      }

      results.sort((a, b) => b.sentAt - a.sentAt)
      const result: ScanResult = { items: results, diagnostics }
      this.scanCache = { key, at: Date.now(), result }
      return result
    })()

    this.scanInFlight = { key, promise: work }
    try {
      return await work
    } finally {
      if (this.scanInFlight?.promise === work) {
        this.scanInFlight = null
      }
    }
  }

  async fetchMessage(
    chatPeer: string,
    botHandle: string,
    msgId: number,
  ): Promise<RawBotMessage | null> {
    if (this.pairingState.status !== 'paired' || !this.client) {
      return null
    }
    const client = await this.ensureClient()
    const normBot = normalizeBotHandle(botHandle)
    const normPeer = normalizeChatPeer(chatPeer) ?? normBot
    if (!normBot || !normPeer) return null

    const isDm = normPeer === normBot
    const { entity, title } = await this.resolveEntity(client, normPeer, isDm)
    const fetched = await client.getMessages(entity as Api.TypeEntityLike, { ids: [msgId] })
    const msg = fetched[0]
    if (!msg) return null

    if (!isDm) {
      const sender = (await msg.getSender?.()) as { bot?: boolean; username?: string } | null
      const senderHandle = sender?.username ? normalizeBotHandle(sender.username) : null
      if (!sender?.bot || senderHandle !== normBot) {
        return null
      }
    }

    const buttons = extractInlineButtons(msg.replyMarkup)
    if (buttons.length === 0) return null
    const rawText = typeof msg.message === 'string' ? msg.message : ''
    const sentAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()
    return {
      botHandle: normBot,
      botTitle: isDm ? title : `@${normBot}`,
      chatPeer: normPeer,
      chatTitle: isDm ? undefined : title,
      msgId: msg.id,
      rawText,
      sentAt,
      buttons,
    }
  }

  async pressCallback(
    chatPeer: string,
    botHandle: string,
    msgId: number,
    data: Uint8Array,
    originalRawText?: string,
  ): Promise<CallbackPressResult> {
    if (this.pairingState.status !== 'paired' || !this.client) {
      throw new Error('NOT_PAIRED')
    }
    const client = await this.ensureClient()
    const normBot = normalizeBotHandle(botHandle)
    const normPeer = normalizeChatPeer(chatPeer) ?? normBot
    if (!normBot || !normPeer) throw new Error('INVALID_PEER')

    const { entity } = await this.resolveEntity(client, normPeer, normPeer === normBot)

    let answer = ''
    let timedOut = false
    try {
      const res = await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: entity as Api.TypeEntityLike,
          msgId,
          data: Buffer.from(data),
        }),
      )
      answer = typeof res.message === 'string' ? res.message.trim() : ''
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('BOT_RESPONSE_TIMEOUT')) {
        timedOut = true
        answer = 'Bot did not answer'
      } else if (/MESSAGE_ID_INVALID|DATA_INVALID/i.test(msg)) {
        throw new Error('BUTTON_NOT_FOUND')
      } else if (/FLOOD_WAIT_(\d+)/i.test(msg)) {
        const secs = /FLOOD_WAIT_(\d+)/i.exec(msg)?.[1] ?? '30'
        throw new Error(`RATE_LIMITED:${secs}`)
      } else {
        throw err
      }
    }

    // Check up to twice (350ms, then +650ms) for a genuine message edit compared to originalRawText
    let editedRawText: string | null = null
    const origNorm = (originalRawText ?? '').trim()
    for (const delayMs of [350, 650]) {
      try {
        await new Promise((r) => setTimeout(r, delayMs))
        const refreshed = await client.getMessages(entity as Api.TypeEntityLike, { ids: [msgId] })
        const updated = refreshed[0]
        if (updated && typeof updated.message === 'string') {
          const nextText = updated.message.trim()
          if (nextText && nextText !== origNorm) {
            editedRawText = nextText
            break
          }
        }
      } catch {
        break
      }
    }

    this.scanCache = null
    return {
      answer: answer || (timedOut ? 'Bot did not answer' : 'Bot answered'),
      editedRawText,
      timedOut,
    }
  }
}
