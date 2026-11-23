import { normalizeBotHandle, type PairingState, type RawBotMessage } from '@bottap/shared'
import type { BotTransport, CallbackPressResult } from './transport.js'

interface DemoRecord {
  botHandle: string
  botTitle: string
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

function createInitialDemoRecords(now: number): DemoRecord[] {
  return [
    {
      botHandle: 'uptime_ops_bot',
      botTitle: 'Uptime Ops',
      msgId: 4101,
      rawText:
        'API-01 502 spike on /health (3/3 probes)\nTrace ID 99b1c — internal payload hidden from glasses.',
      sentAt: now - 3 * 60_000,
      buttons: [
        {
          typeName: 'KeyboardButtonCallback',
          text: 'Ack',
          data: 'uptime:ack:4101',
          style: { bgSuccess: true },
        },
        {
          typeName: 'KeyboardButtonCallback',
          text: 'Mute 1h',
          data: 'uptime:mute1h:4101',
        },
        {
          typeName: 'KeyboardButtonUrl',
          text: 'Open Grafana',
          data: 'https://grafana.internal/d/api-01',
        },
      ],
    },
    {
      botHandle: 'deploy_gate_bot',
      botTitle: 'Deploy Gate',
      msgId: 8209,
      rawText: 'Release v2.14.0 ready for prod-eu-1\nCommit diff and build logs stay in Telegram.',
      sentAt: now - 11 * 60_000,
      buttons: [
        {
          typeName: 'KeyboardButtonCallback',
          text: 'Approve Prod',
          data: 'deploy:approve:8209',
          style: { bgDanger: true },
        },
        {
          typeName: 'KeyboardButtonCallback',
          text: 'Hold',
          data: 'deploy:hold:8209',
        },
        {
          typeName: 'KeyboardButtonWebView',
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
          typeName: 'KeyboardButtonCallback',
          text: 'Rotate Key',
          data: 'vault:rotate:9055',
          requiresPassword: true,
          style: { bgDanger: true },
        },
        {
          typeName: 'KeyboardButtonCallback',
          text: 'Defer 24h',
          data: 'vault:defer:9055',
        },
      ],
    },
    {
      // Intentionally NOT in the default allowlist to prove allowlist isolation
      botHandle: 'random_promo_bot',
      botTitle: 'Promo Bot',
      msgId: 777,
      rawText: 'Claim mystery reward before midnight!',
      sentAt: now - 60_000,
      buttons: [
        {
          typeName: 'KeyboardButtonCallback',
          text: 'Claim',
          data: 'promo:claim:777',
        },
      ],
    },
  ]
}

export class DemoBotTransport implements BotTransport {
  readonly mode = 'demo' as const
  private records: DemoRecord[]
  private paired = true

  constructor(private readonly nowFn: () => number = () => Date.now()) {
    this.records = createInitialDemoRecords(this.nowFn())
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  resetDemo(): void {
    this.records = createInitialDemoRecords(this.nowFn())
    this.paired = true
  }

  getPairingState(): PairingState {
    return {
      status: this.paired ? 'paired' : 'unpaired',
      mode: 'demo',
      hasApiCreds: true,
      accountLabel: this.paired ? 'demo-sandbox (offline fixtures)' : undefined,
    }
  }

  async startQrPairing(): Promise<PairingState> {
    this.paired = true
    return this.getPairingState()
  }

  async pollQrPairing(): Promise<PairingState> {
    return this.getPairingState()
  }

  async startPhonePairing(): Promise<PairingState> {
    this.paired = true
    return this.getPairingState()
  }

  async submitPhoneCode(): Promise<PairingState> {
    this.paired = true
    return this.getPairingState()
  }

  async submit2FAPassword(): Promise<PairingState> {
    this.paired = true
    return this.getPairingState()
  }

  async disconnect(): Promise<PairingState> {
    this.paired = false
    return this.getPairingState()
  }

  async scanPending(allowlist: readonly string[]): Promise<RawBotMessage[]> {
    if (!this.paired) return []
    const allowedSet = new Set(allowlist.map((h) => normalizeBotHandle(h)).filter(Boolean))
    return this.records
      .filter((r) => allowedSet.has(r.botHandle) && r.buttons.length > 0)
      .map((r) => ({
        botHandle: r.botHandle,
        botTitle: r.botTitle,
        msgId: r.msgId,
        rawText: r.rawText,
        sentAt: r.sentAt,
        buttons: r.buttons,
      }))
  }

  async pressCallback(
    botHandle: string,
    msgId: number,
    data: Uint8Array,
  ): Promise<CallbackPressResult> {
    const norm = normalizeBotHandle(botHandle)
    const payload = new TextDecoder().decode(data)
    const rec = this.records.find((r) => r.botHandle === norm && r.msgId === msgId)
    if (!rec) {
      throw new Error('MESSAGE_NOT_FOUND')
    }

    if (payload === 'uptime:ack:4101') {
      rec.rawText = 'Acked by on-call · API-01'
      rec.buttons = []
      return {
        answer: 'Alert acknowledged',
        editedRawText: rec.rawText,
        timedOut: false,
      }
    }
    if (payload === 'uptime:mute1h:4101') {
      rec.rawText = 'Muted 1h · API-01'
      rec.buttons = []
      return {
        answer: 'Silenced for 60m',
        editedRawText: rec.rawText,
        timedOut: false,
      }
    }
    if (payload === 'deploy:approve:8209') {
      rec.rawText = 'Release v2.14.0 promoted to prod-eu-1'
      rec.buttons = []
      return {
        answer: 'Deploy approved',
        editedRawText: rec.rawText,
        timedOut: false,
      }
    }
    if (payload === 'deploy:hold:8209') {
      rec.rawText = 'Release v2.14.0 held by on-call'
      rec.buttons = []
      return {
        answer: 'Deploy held',
        editedRawText: rec.rawText,
        timedOut: false,
      }
    }
    if (payload === 'vault:defer:9055') {
      // Simulate BOT_RESPONSE_TIMEOUT handling from PLAN.md
      rec.buttons = []
      return {
        answer: 'Bot did not answer',
        editedRawText: null,
        timedOut: true,
      }
    }

    rec.buttons = []
    return {
      answer: 'Callback sent',
      editedRawText: null,
      timedOut: false,
    }
  }
}
