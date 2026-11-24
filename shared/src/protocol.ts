export type ButtonStyleKind = 'default' | 'primary' | 'success' | 'danger'

export interface CallbackButton {
  readonly kind: 'callback'
  readonly label: string
  readonly dataB64: string
  readonly danger: boolean
  readonly requiresPassword: boolean
  readonly style: ButtonStyleKind
}

export interface QueueItem {
  readonly id: string
  readonly bot: string
  readonly botTitle: string
  readonly msgId: number
  readonly line: string
  readonly sentAt: number
  readonly buttons: readonly CallbackButton[]
  readonly hiddenNonCallbackCount: number
}

export interface ArmRequest {
  readonly bot: string
  readonly msgId: number
  readonly dataB64: string
}

export interface ArmResponse {
  readonly ok: true
  readonly armToken: string
  readonly expiresAt: number
}

export interface PressRequest {
  readonly bot: string
  readonly msgId: number
  readonly dataB64: string
  readonly confirmedDanger?: boolean
  readonly armToken?: string
}

export type PressErrorCode =
  | 'BOT_NOT_ALLOWLISTED'
  | 'DANGER_CONFIRMATION_REQUIRED'
  | 'PASSWORD_REQUIRED'
  | 'BUTTON_NOT_FOUND'
  | 'NOT_PAIRED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'TRANSPORT_ERROR'

export type PressOutcome =
  | {
      readonly ok: true
      readonly bot: string
      readonly msgId: number
      readonly buttonLabel: string
      readonly answer: string
      readonly editedLine: string | null
      readonly timedOut: boolean
      readonly pressedAt: number
    }
  | {
      readonly ok: false
      readonly code: PressErrorCode
      readonly message: string
    }

export type GatewayMode = 'live' | 'demo'

export interface PairingState {
  readonly status: 'unpaired' | 'awaiting_code' | 'awaiting_2fa' | 'qr_pending' | 'paired'
  readonly mode: GatewayMode
  readonly hasApiCreds: boolean
  readonly accountLabel?: string
  readonly phoneMask?: string
  readonly qrUrl?: string
  readonly qrExpiresAt?: number
  readonly error?: string
}

export type AuditOutcome =
  | 'pressed'
  | 'timeout'
  | 'refused_2fa'
  | 'refused_allowlist'
  | 'refused_danger_unconfirmed'

export interface AuditEntry {
  readonly id: string
  readonly at: number
  readonly bot: string
  readonly msgId: number
  readonly buttonLabel: string
  readonly outcome: AuditOutcome
  readonly detail: string
}

export interface GatewayStatus {
  readonly ok: true
  readonly mode: GatewayMode
  readonly pairing: PairingState
  readonly allowlist: readonly string[]
  readonly pendingCount: number
  readonly recentAudit: readonly AuditEntry[]
}

export interface PendingResponse {
  readonly mode: GatewayMode
  readonly paired: boolean
  readonly allowlist: readonly string[]
  readonly items: readonly QueueItem[]
  readonly fetchedAt: number
}

export type G2ViewState =
  | { readonly screen: 'loading' }
  | { readonly screen: 'offline'; readonly message: string }
  | { readonly screen: 'unpaired'; readonly mode: GatewayMode }
  | { readonly screen: 'empty'; readonly allowlistCount: number; readonly mode: GatewayMode }
  | { readonly screen: 'queue'; readonly items: readonly QueueItem[]; readonly cursor: number }
  | {
      readonly screen: 'buttons'
      readonly items: readonly QueueItem[]
      readonly itemIndex: number
      readonly buttonIndex: number
    }
  | {
      readonly screen: 'danger_confirm'
      readonly items: readonly QueueItem[]
      readonly itemIndex: number
      readonly buttonIndex: number
      readonly armedAt: number
    }
  | {
      readonly screen: 'pressing'
      readonly items: readonly QueueItem[]
      readonly itemIndex: number
      readonly item: QueueItem
      readonly button: CallbackButton
    }
  | {
      readonly screen: 'result'
      readonly items: readonly QueueItem[]
      readonly itemIndex: number
      readonly bot: string
      readonly buttonLabel: string
      readonly headline: string
      readonly detail: string
      readonly timedOut: boolean
      readonly shownAt: number
    }
  | {
      readonly screen: 'refusal'
      readonly items: readonly QueueItem[]
      readonly itemIndex: number
      readonly reason: 'requires_password' | 'not_allowlisted'
      readonly bot: string
      readonly buttonLabel: string
      readonly headline: string
      readonly detail: string
      readonly shownAt: number
    }
