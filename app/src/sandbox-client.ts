import {
  buildQueueItem,
  isAllowlisted,
  normalizeAllowlist,
  normalizeBotHandle,
  sanitizeAlertLine,
  type ArmRequest,
  type ArmResponse,
  type AuditEntry,
  type AuditOutcome,
  type GatewayStatus,
  type PairingState,
  type PendingResponse,
  type PressOutcome,
  type PressRequest,
  type RawBotMessage,
} from '@bottap/shared'
import type { BotTapGatewayApi, GatewayClientConfig } from './client'

interface SandboxRecord {
  botHandle: string
  botTitle: string
  chatPeer?: string
  chatTitle?: string
  msgId: number
  rawText: string
  sentAt: number
  buttons: Array<{
    typeName: string
    text: string
    data?: string
    requiresPassword?: boolean
    style?: { bgDanger?: boolean; bgPrimary?: boolean; bgSuccess?: boolean }
  }>
}

function makeSandboxFixtures(now: number): SandboxRecord[] {
  return [
    {
      botHandle: 'uptime_ops_bot',
      botTitle: 'Uptime Ops',
      chatPeer: '-1001999888777',
      chatTitle: '#ops-alerts',
      msgId: 4101,
      rawText:
        'API-01 502 spike on /health (3/3 probes)\nTrace ID 99b1c — body stays in Telegram.',
      sentAt: now - 3 * 60_000,
      buttons: [
        {
          typeName: 'InlineButtonTypeCallback',
          text: 'Ack',
          data: 'uptime:ack:4101',
          style: { bgSuccess: true },
        },
        {
          typeName: 'InlineButtonTypeCallback',
          text: 'Mute 1h',
          data: 'uptime:mute1h:4101',
        },
        {
          typeName: 'InlineButtonTypeUrl',
          text: 'Open Grafana',
          data: 'https://grafana.internal/d/api-01',
        },
      ],
    },
    {
      botHandle: 'deploy_gate_bot',
      botTitle: 'Deploy Gate',
      msgId: 8209,
      rawText: 'Release v2.14.0 ready for prod-eu-1\nPipeline #8209 green (42/42 checks).',
      sentAt: now - 11 * 60_000,
      buttons: [
        {
          typeName: 'InlineButtonTypeCallback',
          text: 'Approve Prod',
          data: 'deploy:approve:8209',
          style: { bgDanger: true },
        },
        {
          typeName: 'InlineButtonTypeCallback',
          text: 'Hold',
          data: 'deploy:hold:8209',
        },
        {
          typeName: 'InlineButtonTypeWebView',
          text: 'Inspect Diff',
          data: 'https://ci.internal/diff/8209',
        },
      ],
    },
    {
      botHandle: 'vault_guard_bot',
      botTitle: 'Vault Guard',
      msgId: 9055,
      rawText: 'Rotate HSM signing key (2FA required)',
      sentAt: now - 28 * 60_000,
      buttons: [
        {
          typeName: 'InlineButtonTypeCallback',
          text: 'Rotate Key',
          data: 'vault:rotate:9055',
          requiresPassword: true,
          style: { bgDanger: true },
        },
        {
          typeName: 'InlineButtonTypeCallback',
          text: 'Defer 24h',
          data: 'vault:defer:9055',
        },
      ],
    },
  ]
}

/**
 * Deterministic in-browser sandbox client for zero-setup static judge previews
 * (no Telegram session, no network backend required). Enforces the exact same
 * shared classifier, allowlist, 2FA refusal, and two-step arm-token gates.
 */
export class BrowserSandboxClient implements BotTapGatewayApi {
  readonly isBrowserSandbox = true
  private allowlist = ['uptime_ops_bot', 'deploy_gate_bot', 'vault_guard_bot']
  private readonly groups = ['-1001999888777']
  private records: SandboxRecord[] = makeSandboxFixtures(Date.now())
  private audit: AuditEntry[] = []
  private armedTokens = new Map<string, { key: string; expiresAt: number }>()
  private config: GatewayClientConfig = { baseUrl: 'sandbox://in-browser' }

  configure(config: GatewayClientConfig): void {
    this.config = { ...config }
  }

  getConfig(): GatewayClientConfig {
    return { ...this.config }
  }

  private log(bot: string, msgId: number, buttonLabel: string, outcome: AuditOutcome, detail: string) {
    this.audit = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        bot,
        msgId,
        buttonLabel,
        outcome,
        detail: sanitizeAlertLine(detail, 64),
      },
      ...this.audit,
    ].slice(0, 50)
  }

  private queueItems() {
    const out = []
    for (const r of this.records) {
      if (r.buttons.length === 0) continue
      const raw: RawBotMessage = {
        botHandle: r.botHandle,
        botTitle: r.botTitle,
        chatPeer: r.chatPeer ?? r.botHandle,
        chatTitle: r.chatTitle,
        msgId: r.msgId,
        rawText: r.rawText,
        sentAt: r.sentAt,
        buttons: r.buttons,
      }
      const built = buildQueueItem(raw, this.allowlist)
      if (built) out.push(built)
    }
    return out
  }

  private pairingState(): PairingState {
    return {
      status: 'paired',
      mode: 'demo',
      hasApiCreds: false,
      accountLabel: 'Browser sandbox (no Telegram connection)',
    }
  }

  async getStatus(): Promise<GatewayStatus> {
    const items = this.queueItems()
    return {
      ok: true,
      mode: 'demo',
      pairing: this.pairingState(),
      allowlist: [...this.allowlist],
      groups: [...this.groups],
      pendingCount: items.length,
      scanDiagnostics: [],
      recentAudit: [...this.audit],
    }
  }

  async getPending(): Promise<PendingResponse> {
    return {
      mode: 'demo',
      paired: true,
      allowlist: [...this.allowlist],
      groups: [...this.groups],
      items: this.queueItems(),
      scanDiagnostics: [],
      fetchedAt: Date.now(),
    }
  }

  async armDanger(req: ArmRequest): Promise<ArmResponse> {
    const item = this.queueItems().find(
      (i) => i.bot === req.bot && i.msgId === req.msgId && i.chatPeer === (req.chatPeer ?? req.bot),
    )
    const btn = item?.buttons.find((b) => b.dataB64 === req.dataB64)
    if (!item || !btn || !btn.danger) {
      throw new Error('Danger button no longer present')
    }
    const token = `sbx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const expiresAt = Date.now() + 8_000
    this.armedTokens.set(token, {
      key: `${item.chatPeer}:${item.bot}:${item.msgId}:${btn.dataB64}:${item.line}`,
      expiresAt,
    })
    this.log(item.bot, item.msgId, btn.label, 'arm_issued', `Armed (${btn.dangerSource ?? 'policy'})`)
    return { ok: true, armToken: token, expiresAt }
  }

  async press(req: PressRequest): Promise<PressOutcome> {
    const bot = normalizeBotHandle(req.bot)
    if (!bot || !isAllowlisted(bot, this.allowlist)) {
      return { ok: false, code: 'BOT_NOT_ALLOWLISTED', message: `@${req.bot} is not on the allowlist` }
    }
    const chatPeer = req.chatPeer ?? bot
    const item = this.queueItems().find((i) => i.bot === bot && i.chatPeer === chatPeer && i.msgId === req.msgId)
    const btn = item?.buttons.find((b) => b.dataB64 === req.dataB64)
    if (!item || !btn) {
      return { ok: false, code: 'BUTTON_NOT_FOUND', message: 'Callback button no longer present' }
    }
    if (btn.requiresPassword) {
      this.log(bot, req.msgId, btn.label, 'refused_2fa', '2FA button - open Telegram')
      return { ok: false, code: 'PASSWORD_REQUIRED', message: '2FA button - open Telegram' }
    }
    if (btn.danger) {
      const rec = req.armToken ? this.armedTokens.get(req.armToken) : undefined
      const expected = `${chatPeer}:${bot}:${req.msgId}:${req.dataB64}:${item.line}`
      if (!req.confirmedDanger || !rec || Date.now() >= rec.expiresAt || rec.key !== expected) {
        this.log(bot, req.msgId, btn.label, 'refused_danger_unconfirmed', 'Missing valid arm token')
        return {
          ok: false,
          code: 'DANGER_CONFIRMATION_REQUIRED',
          message: 'Double-press arm token required for destructive button',
        }
      }
      this.armedTokens.delete(req.armToken!)
    }

    const rawRec = this.records.find(
      (r) => r.botHandle === bot && (r.chatPeer ?? r.botHandle) === chatPeer && r.msgId === req.msgId,
    )!
    const payload = atob(req.dataB64)
    let answer = 'Bot answered'
    let editedLine: string | null = null
    let timedOut = false

    if (payload === 'uptime:ack:4101') {
      answer = 'Alert acknowledged'
      editedLine = 'Acked by on-call · API-01'
    } else if (payload === 'uptime:mute1h:4101') {
      answer = 'Silenced for 60m'
      editedLine = 'Muted 1h · API-01'
    } else if (payload === 'deploy:approve:8209') {
      answer = 'Deploy approved'
      editedLine = 'Release v2.14.0 promoted to prod-eu-1'
    } else if (payload === 'deploy:hold:8209') {
      answer = 'Deploy held'
      editedLine = 'Release v2.14.0 held by on-call'
    } else if (payload === 'vault:defer:9055') {
      answer = 'Bot did not answer'
      timedOut = true
    }

    rawRec.buttons = []
    if (editedLine) rawRec.rawText = editedLine
    this.log(bot, req.msgId, btn.label, timedOut ? 'timeout' : 'pressed', editedLine || answer)

    return {
      ok: true,
      bot,
      chatPeer,
      msgId: req.msgId,
      buttonLabel: btn.label,
      answer,
      editedLine,
      timedOut,
      pressedAt: Date.now(),
    }
  }

  async addAllowlist(bot: string): Promise<{ ok: boolean; allowlist: string[] }> {
    const norm = normalizeBotHandle(bot)
    if (!norm) throw new Error('Valid bot username required')
    this.allowlist = normalizeAllowlist([...this.allowlist, norm])
    this.log(norm, 0, 'allowlist', 'allowlist_add', `Added @${norm}`)
    return { ok: true, allowlist: [...this.allowlist] }
  }

  async removeAllowlist(bot: string): Promise<{ ok: boolean; allowlist: string[] }> {
    const norm = normalizeBotHandle(bot) ?? bot
    this.allowlist = this.allowlist.filter((b) => b !== norm)
    this.log(norm, 0, 'allowlist', 'allowlist_remove', `Removed @${norm}`)
    return { ok: true, allowlist: [...this.allowlist] }
  }

  async startQrPairing(): Promise<{ ok: boolean; pairing: PairingState }> {
    return { ok: true, pairing: this.pairingState() }
  }
  async pollQrPairing(): Promise<{ ok: boolean; pairing: PairingState }> {
    return { ok: true, pairing: this.pairingState() }
  }
  async startPhonePairing(): Promise<{ ok: boolean; pairing: PairingState }> {
    return { ok: true, pairing: this.pairingState() }
  }
  async submitPhoneCode(): Promise<{ ok: boolean; pairing: PairingState }> {
    return { ok: true, pairing: this.pairingState() }
  }
  async submit2FA(): Promise<{ ok: boolean; pairing: PairingState }> {
    return { ok: true, pairing: this.pairingState() }
  }
  async disconnect(): Promise<{ ok: boolean; pairing: PairingState }> {
    return { ok: true, pairing: this.pairingState() }
  }

  async resetDemo(): Promise<{ ok: boolean }> {
    this.records = makeSandboxFixtures(Date.now())
    this.armedTokens.clear()
    return { ok: true }
  }
}
