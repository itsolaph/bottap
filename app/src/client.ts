import type {
  ArmRequest,
  ArmResponse,
  GatewayStatus,
  PairingState,
  PendingResponse,
  PressOutcome,
  PressRequest,
} from '@bottap/shared'

const REQUEST_TIMEOUT_MS = 15_000

export function isSecureOrLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(
      rawUrl,
      typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1',
    )
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export interface GatewayClientConfig {
  baseUrl: string
  token?: string
}

export interface BotTapGatewayApi {
  readonly isBrowserSandbox: boolean
  configure(config: GatewayClientConfig): void
  getConfig(): GatewayClientConfig
  getStatus(): Promise<GatewayStatus>
  getPending(): Promise<PendingResponse>
  armDanger(req: ArmRequest): Promise<ArmResponse>
  press(req: PressRequest): Promise<PressOutcome>
  addAllowlist(bot: string): Promise<{ ok: boolean; allowlist: string[] }>
  removeAllowlist(bot: string): Promise<{ ok: boolean; allowlist: string[] }>
  startQrPairing(): Promise<{ ok: boolean; pairing: PairingState }>
  pollQrPairing(): Promise<{ ok: boolean; pairing: PairingState }>
  startPhonePairing(phoneNumber: string): Promise<{ ok: boolean; pairing: PairingState }>
  submitPhoneCode(code: string): Promise<{ ok: boolean; pairing: PairingState }>
  submit2FA(password: string): Promise<{ ok: boolean; pairing: PairingState }>
  disconnect(): Promise<{ ok: boolean; pairing: PairingState }>
  resetDemo(): Promise<{ ok: boolean }>
}

export class GatewayClient implements BotTapGatewayApi {
  readonly isBrowserSandbox = false
  private baseUrl: string
  private token?: string

  constructor(config: GatewayClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token?.trim() || undefined
  }

  configure(config: GatewayClientConfig): void {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token?.trim() || undefined
  }

  getConfig(): GatewayClientConfig {
    return { baseUrl: this.baseUrl, token: this.token }
  }

  private headers(hasBody = false): Record<string, string> {
    const h: Record<string, string> = {}
    if (hasBody) h['Content-Type'] = 'application/json'
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) {
        throw new Error(`Gateway returned non-JSON response (HTTP ${res.status})`)
      }
      const json = (await res.json()) as T & { message?: string }
      if (!res.ok && path !== '/press') {
        throw new Error(json.message || `HTTP ${res.status}`)
      }
      return json
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Gateway request timed out')
      }
      throw err
    } finally {
      globalThis.clearTimeout(timer)
    }
  }

  private assertTransportSafeForSecret(): void {
    if (!isSecureOrLoopbackUrl(this.baseUrl)) {
      throw new Error('Use HTTPS (or localhost) before pairing a Telegram session')
    }
  }

  getStatus(): Promise<GatewayStatus> {
    return this.request<GatewayStatus>('GET', '/status')
  }

  getPending(): Promise<PendingResponse> {
    return this.request<PendingResponse>('GET', '/pending')
  }

  armDanger(req: ArmRequest): Promise<ArmResponse> {
    return this.request<ArmResponse>('POST', '/arm', req)
  }

  press(req: PressRequest): Promise<PressOutcome> {
    return this.request<PressOutcome>('POST', '/press', req)
  }

  addAllowlist(bot: string): Promise<{ ok: boolean; allowlist: string[] }> {
    return this.request('POST', '/allowlist', { bot })
  }

  removeAllowlist(bot: string): Promise<{ ok: boolean; allowlist: string[] }> {
    return this.request('DELETE', `/allowlist/${encodeURIComponent(bot)}`)
  }

  startQrPairing(): Promise<{ ok: boolean; pairing: PairingState }> {
    this.assertTransportSafeForSecret()
    return this.request('POST', '/pairing/qr')
  }

  pollQrPairing(): Promise<{ ok: boolean; pairing: PairingState }> {
    this.assertTransportSafeForSecret()
    return this.request('GET', '/pairing/qr')
  }

  startPhonePairing(phoneNumber: string): Promise<{ ok: boolean; pairing: PairingState }> {
    this.assertTransportSafeForSecret()
    return this.request('POST', '/pairing/phone', { phoneNumber })
  }

  submitPhoneCode(code: string): Promise<{ ok: boolean; pairing: PairingState }> {
    this.assertTransportSafeForSecret()
    return this.request('POST', '/pairing/code', { code })
  }

  submit2FA(password: string): Promise<{ ok: boolean; pairing: PairingState }> {
    this.assertTransportSafeForSecret()
    return this.request('POST', '/pairing/2fa', { password })
  }

  disconnect(): Promise<{ ok: boolean; pairing: PairingState }> {
    return this.request('POST', '/pairing/disconnect')
  }

  resetDemo(): Promise<{ ok: boolean }> {
    return this.request('POST', '/demo/reset')
  }
}
