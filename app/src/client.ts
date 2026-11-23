import type {
  GatewayStatus,
  PairingState,
  PendingResponse,
  PressOutcome,
  PressRequest,
} from '@bottap/shared'

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

  startPhonePairing(phoneNumber: string): Promise<{ ok: boolean; pairing: PairingState }> {
    return this.request('POST', '/pairing/phone', { phoneNumber })
  }

  submitPhoneCode(code: string): Promise<{ ok: boolean; pairing: PairingState }> {
    return this.request('POST', '/pairing/code', { code })
  }

  submit2FA(password: string): Promise<{ ok: boolean; pairing: PairingState }> {
    return this.request('POST', '/pairing/2fa', { password })
  }

  disconnect(): Promise<{ ok: boolean; pairing: PairingState }> {
    return this.request('POST', '/pairing/disconnect')
  }

  resetDemo(): Promise<{ ok: boolean }> {
    return this.request('POST', '/demo/reset')
  }
}
