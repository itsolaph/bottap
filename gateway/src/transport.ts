import type { GatewayMode, PairingState, RawBotMessage } from '@bottap/shared'

export interface CallbackPressResult {
  readonly answer: string
  readonly editedRawText: string | null
  readonly timedOut: boolean
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
  scanPending(allowlist: readonly string[]): Promise<RawBotMessage[]>
  pressCallback(botHandle: string, msgId: number, data: Uint8Array): Promise<CallbackPressResult>
  resetDemo?(): void
}
