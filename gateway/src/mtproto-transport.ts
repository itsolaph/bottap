import { TelegramClient, Api, sessions, password as tgPassword } from 'teleproto'
import { normalizeBotHandle, type PairingState, type RawBotMessage, type RawInlineButton } from '@bottap/shared'
import type { GatewayStore } from './store.js'
import type { BotTransport, CallbackPressResult } from './transport.js'

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

function extractInlineButtons(markup: unknown): RawInlineButton[] {
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
        style?: {
          bgDanger?: boolean
          bgPrimary?: boolean
          bgSuccess?: boolean
        }
      }
      out.push({
        typeName: b.className ?? 'UnknownButton',
        text: typeof b.text === 'string' ? b.text : '',
        data: b.data instanceof Uint8Array ? new Uint8Array(b.data) : undefined,
        requiresPassword: Boolean(b.requiresPassword),
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

export class MtprotoBotTransport implements BotTransport {
  readonly mode = 'live' as const
  private client: TelegramClient | null = null
  private pairingState: PairingState
  private pendingPhone: { phoneNumber: string; phoneCodeHash: string } | null = null
  private entityCache = new Map<string, { entity: unknown; title: string; cachedAt: number }>()

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
    return this.pollQrPairing()
  }

  async pollQrPairing(): Promise<PairingState> {
    const client = await this.ensureClient()
    if (await client.isUserAuthorized()) {
      return this.refreshAuthorizedProfile(client)
    }
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
        this.pairingState = {
          status: 'qr_pending',
          mode: 'live',
          hasApiCreds: true,
          qrUrl: `tg://login?token=${tokenB64Url}`,
          qrExpiresAt: res.expires * 1000,
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
        error: msg,
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

  async submitPhoneCode(code: string): Promise<PairingState> {
    if (!this.pendingPhone) {
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
      return this.refreshAuthorizedProfile(client)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        this.pairingState = {
          status: 'awaiting_2fa',
          mode: 'live',
          hasApiCreds: true,
          phoneMask: maskPhone(this.pendingPhone.phoneNumber),
        }
        return this.getPairingState()
      }
      throw err
    }
  }

  async submit2FAPassword(password: string): Promise<PairingState> {
    const client = await this.ensureClient()
    const srpParams = await client.invoke(new Api.account.GetPassword())
    const check = await tgPassword.computeCheck(srpParams, password)
    await client.invoke(new Api.auth.CheckPassword({ password: check }))
    return this.refreshAuthorizedProfile(client)
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
    this.pendingPhone = null
    this.pairingState = {
      status: 'unpaired',
      mode: 'live',
      hasApiCreds: this.pairingState.hasApiCreds,
    }
    return this.getPairingState()
  }

  private async resolveBotEntity(client: TelegramClient, handle: string) {
    const norm = normalizeBotHandle(handle)
    if (!norm) throw new Error('Invalid bot handle')
    const cached = this.entityCache.get(norm)
    if (cached && Date.now() - cached.cachedAt < 5 * 60_000) {
      return cached
    }
    const entity = await client.getEntity(norm)
    const e = entity as { firstName?: string; title?: string; username?: string }
    const title = e.firstName || e.title || `@${norm}`
    const record = { entity, title, cachedAt: Date.now() }
    this.entityCache.set(norm, record)
    return record
  }

  async scanPending(allowlist: readonly string[]): Promise<RawBotMessage[]> {
    if (this.pairingState.status !== 'paired' || !this.client) {
      return []
    }
    const client = await this.ensureClient()
    const results: RawBotMessage[] = []

    for (const handle of allowlist) {
      const norm = normalizeBotHandle(handle)
      if (!norm) continue
      try {
        const { entity, title } = await this.resolveBotEntity(client, norm)
        const messages = await client.getMessages(entity as Api.TypeEntityLike, { limit: 8 })
        for (const msg of messages) {
          const buttons = extractInlineButtons(msg.replyMarkup)
          if (buttons.length === 0) continue
          const rawText = typeof msg.message === 'string' ? msg.message : ''
          const sentAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()
          results.push({
            botHandle: norm,
            botTitle: title,
            msgId: msg.id,
            rawText,
            sentAt,
            buttons,
          })
        }
      } catch {
        // Skip unreachable/unstarted bot without failing the whole queue
      }
    }

    results.sort((a, b) => b.sentAt - a.sentAt)
    return results
  }

  async pressCallback(
    botHandle: string,
    msgId: number,
    data: Uint8Array,
  ): Promise<CallbackPressResult> {
    if (this.pairingState.status !== 'paired' || !this.client) {
      throw new Error('NOT_PAIRED')
    }
    const client = await this.ensureClient()
    const { entity } = await this.resolveBotEntity(client, botHandle)

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
      } else {
        throw err
      }
    }

    // Brief settle to read the bot's edited alert line (if any) without scanning history
    let editedRawText: string | null = null
    try {
      await new Promise((r) => setTimeout(r, 350))
      const refreshed = await client.getMessages(entity as Api.TypeEntityLike, { ids: [msgId] })
      const updated = refreshed[0]
      if (updated && typeof updated.message === 'string' && updated.message.trim()) {
        editedRawText = updated.message
      }
    } catch {
      // Optional confirmation read; press itself already succeeded
    }

    return {
      answer: answer || (timedOut ? 'Bot did not answer' : 'Confirmed'),
      editedRawText,
      timedOut,
    }
  }
}
