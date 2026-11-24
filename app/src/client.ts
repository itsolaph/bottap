import type {
  ArmRequest,
  ArmResponse,
  GatewayStatus,
  PairingState,
  PendingResponse,
  PressOutcome,
  PressRequest,
} from '@bottap/shared'

export function isSecureOrLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl, typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1')
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

export class GatewayClient {
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
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = (await res.json().catch(() => ({}))) as T & { message?: string }
    if (!res.ok && path !== '/press') {
      throw new Error(json.message || `HTTP ${res.status}`)
    }
    return json
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
    return this.request('POST', '/pairing/qr')
  }

  pollQrPairing(): Promise<{ ok: boolean; pairing: PairingState }> {
    return this.request('GET', '/pairing/qr')
  }

  private assertTransportSafeForSecret(): void {
    if (!isSecureOrLoopbackUrl(this.baseUrl)) {
      throw new Error('Use HTTPS (or localhost) before submitting Telegram login codes or 2FA passwords')
    }
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
