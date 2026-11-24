import type { GatewayMode, PairingState, RawBotMessage, ScanDiagnostic } from '@bottap/shared'

export interface CallbackPressResult {
  readonly answer: string
  readonly editedRawText: string | null
  readonly timedOut: boolean
}

export interface ScanResult {
  readonly items: RawBotMessage[]
  readonly diagnostics: ScanDiagnostic[]
}

export interface BotTransport {
  readonly mode: GatewayMode
  init(): Promise<void>
  close(): Promise<void>
  getPairingState(): PairingState
  startQrPairing(): Promise<PairingState>
  pollQrPairing(): Promise<PairingState>
  startPhonePairing(phoneNumber: string): Promise<PairingState>
  submitPhoneCode(code: string): Promise<PairingState>
  submit2FAPassword(password: string): Promise<PairingState>
  disconnect(): Promise<PairingState>
  scanPending(allowlist: readonly string[], groups?: readonly string[]): Promise<ScanResult>
  fetchMessage(chatPeer: string, botHandle: string, msgId: number): Promise<RawBotMessage | null>
  pressCallback(
    chatPeer: string,
    botHandle: string,
    msgId: number,
    data: Uint8Array,
    originalRawText?: string,
  ): Promise<CallbackPressResult>
  resetDemo?(): void
}
