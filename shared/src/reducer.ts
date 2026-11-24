import type {
  ArmRequest,
  G2ViewState,
  GatewayMode,
  PressOutcome,
  PressRequest,
  QueueItem,
} from './protocol.js'

export const DANGER_ARM_TIMEOUT_MS = 6000
export const RESULT_DISPLAY_MS = 2200

export type G2Action =
  | {
      readonly type: 'SYNC_OK'
      readonly paired: boolean
      readonly mode: GatewayMode
      readonly allowlistCount: number
      readonly items: readonly QueueItem[]
    }
  | { readonly type: 'SYNC_ERROR'; readonly message: string }
  | { readonly type: 'SCROLL_UP' }
  | { readonly type: 'SCROLL_DOWN' }
  | { readonly type: 'FOCUS_ITEM'; readonly index: number; readonly openButtons?: boolean }
  | { readonly type: 'TAP'; readonly now: number }
  | { readonly type: 'DOUBLE_TAP' }
  | { readonly type: 'PRESS_DONE'; readonly outcome: PressOutcome; readonly now: number }
  | { readonly type: 'TICK'; readonly now: number }

export type G2Effect =
  | { readonly type: 'ARM_DANGER'; readonly req: ArmRequest }
  | { readonly type: 'PRESS'; readonly req: PressRequest }
  | { readonly type: 'REFRESH' }
  | { readonly type: 'SHUTDOWN_G2' }

export interface G2Transition {
  readonly state: G2ViewState
  readonly effect?: G2Effect
}

export function initialG2State(): G2ViewState {
  return { screen: 'loading' }
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

function wrap(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}

function returnToQueue(
  items: readonly QueueItem[],
  preferredIndex: number,
  allowlistCount: number,
  mode: GatewayMode,
): G2ViewState {
  if (items.length === 0) {
    return { screen: 'empty', allowlistCount, mode }
  }
  return {
    screen: 'queue',
    items,
    cursor: clamp(preferredIndex, items.length),
  }
}

export function reduceG2State(
  state: G2ViewState,
  action: G2Action,
  meta: { allowlistCount: number; mode: GatewayMode } = { allowlistCount: 0, mode: 'live' },
): G2Transition {
  switch (action.type) {
    case 'SYNC_ERROR': {
      if (state.screen === 'pressing' || state.screen === 'result' || state.screen === 'refusal') {
        return { state }
      }
      return {
        state: { screen: 'offline', message: action.message || 'Gateway unreachable' },
      }
    }

    case 'SYNC_OK': {
      if (!action.paired) {
        return { state: { screen: 'unpaired', mode: action.mode } }
      }
      // Keep active press/result/refusal/danger screens stable, while keeping items fresh
      if (state.screen === 'pressing' || state.screen === 'result' || state.screen === 'refusal') {
        return {
          state: {
            ...state,
            items: action.items,
            itemIndex: clamp(state.itemIndex, action.items.length),
          },
        }
      }
      if (state.screen === 'danger_confirm') {
        return { state }
      }
      if (action.items.length === 0) {
        return {
          state: {
            screen: 'empty',
            allowlistCount: action.allowlistCount,
            mode: action.mode,
          },
        }
      }
      if (state.screen === 'buttons') {
        const currentId = state.items[state.itemIndex]?.id
        const nextIdx = currentId ? action.items.findIndex((x) => x.id === currentId) : -1
        if (nextIdx >= 0) {
          const item = action.items[nextIdx]!
          return {
            state: {
              screen: 'buttons',
              items: action.items,
              itemIndex: nextIdx,
              buttonIndex: clamp(state.buttonIndex, item.buttons.length),
            },
          }
        }
      }
      const prevCursor = state.screen === 'queue' ? state.cursor : 0
      return {
        state: {
          screen: 'queue',
          items: action.items,
          cursor: clamp(prevCursor, action.items.length),
        },
      }
    }

    case 'SCROLL_UP': {
      if (state.screen === 'queue') {
        return {
          state: {
            ...state,
            cursor: wrap(state.cursor, -1, state.items.length),
          },
        }
      }
      if (state.screen === 'buttons') {
        const item = state.items[state.itemIndex]
        if (!item) return { state }
        return {
          state: {
            ...state,
            buttonIndex: wrap(state.buttonIndex, -1, item.buttons.length),
          },
        }
      }
      if (state.screen === 'danger_confirm') {
        // Scrolling cancels the armed danger confirmation safely
        return {
          state: {
            screen: 'buttons',
            items: state.items,
            itemIndex: state.itemIndex,
            buttonIndex: state.buttonIndex,
          },
        }
      }
      return { state }
    }

    case 'SCROLL_DOWN': {
      if (state.screen === 'queue') {
        return {
          state: {
            ...state,
            cursor: wrap(state.cursor, 1, state.items.length),
          },
        }
      }
      if (state.screen === 'buttons') {
        const item = state.items[state.itemIndex]
        if (!item) return { state }
        return {
          state: {
            ...state,
            buttonIndex: wrap(state.buttonIndex, 1, item.buttons.length),
          },
        }
      }
      if (state.screen === 'danger_confirm') {
        return {
          state: {
            screen: 'buttons',
            items: state.items,
            itemIndex: state.itemIndex,
            buttonIndex: state.buttonIndex,
          },
        }
      }
      return { state }
    }

    case 'FOCUS_ITEM': {
      const items =
        state.screen === 'queue' ||
        state.screen === 'buttons' ||
        state.screen === 'danger_confirm' ||
        state.screen === 'result' ||
        state.screen === 'refusal'
          ? state.items
          : null
      if (!items || items.length === 0) return { state }
      const idx = clamp(action.index, items.length)
      if (action.openButtons) {
        return {
          state: {
            screen: 'buttons',
            items,
            itemIndex: idx,
            buttonIndex: 0,
          },
        }
      }
      return {
        state: {
          screen: 'queue',
          items,
          cursor: idx,
        },
      }
    }

    case 'DOUBLE_TAP': {
      if (state.screen === 'danger_confirm') {
        return {
          state: {
            screen: 'buttons',
            items: state.items,
            itemIndex: state.itemIndex,
            buttonIndex: state.buttonIndex,
          },
        }
      }
      if (state.screen === 'buttons') {
        return {
          state: {
            screen: 'queue',
            items: state.items,
            cursor: state.itemIndex,
          },
        }
      }
      if (state.screen === 'result' || state.screen === 'refusal') {
        return {
          state: returnToQueue(state.items, state.itemIndex, meta.allowlistCount, meta.mode),
          effect: { type: 'REFRESH' },
        }
      }
      // Root screens exit cleanly on double-tap (Even Hub UX requirement)
      return { state, effect: { type: 'SHUTDOWN_G2' } }
    }

    case 'TAP': {
      if (state.screen === 'empty' || state.screen === 'offline' || state.screen === 'unpaired') {
        return { state, effect: { type: 'REFRESH' } }
      }
      if (state.screen === 'queue') {
        const item = state.items[state.cursor]
        if (!item) return { state }
        return {
          state: {
            screen: 'buttons',
            items: state.items,
            itemIndex: state.cursor,
            buttonIndex: 0,
          },
        }
      }
      if (state.screen === 'buttons') {
        const item = state.items[state.itemIndex]
        const button = item?.buttons[state.buttonIndex]
        if (!item || !button) return { state }

        // Protocol-level refusal: requires_password (2FA) never executes from glasses
        if (button.requiresPassword) {
          return {
            state: {
              screen: 'refusal',
              items: state.items,
              itemIndex: state.itemIndex,
              reason: 'requires_password',
              bot: item.bot,
              buttonLabel: button.label,
              headline: '2FA button - open Telegram',
              detail: 'Password-gated actions are blocked on G2',
              shownAt: action.now,
            },
          }
        }

        // Protocol-level safety: bg_danger requires explicit second tap + server arm token
        if (button.danger) {
          return {
            state: {
              screen: 'danger_confirm',
              items: state.items,
              itemIndex: state.itemIndex,
              buttonIndex: state.buttonIndex,
              armedAt: action.now,
            },
            effect: {
              type: 'ARM_DANGER',
              req: {
                bot: item.bot,
                msgId: item.msgId,
                dataB64: button.dataB64,
              },
            },
          }
        }

        return {
          state: {
            screen: 'pressing',
            items: state.items,
            itemIndex: state.itemIndex,
            item,
            button,
          },
          effect: {
            type: 'PRESS',
            req: {
              bot: item.bot,
              msgId: item.msgId,
              dataB64: button.dataB64,
              confirmedDanger: false,
            },
          },
        }
      }

      if (state.screen === 'danger_confirm') {
        const item = state.items[state.itemIndex]
        const button = item?.buttons[state.buttonIndex]
        if (!item || !button) {
          return {
            state: returnToQueue(state.items, state.itemIndex, meta.allowlistCount, meta.mode),
          }
        }
        // If arm window expired, disarm back to buttons instead of executing
        if (action.now - state.armedAt > DANGER_ARM_TIMEOUT_MS) {
          return {
            state: {
              screen: 'buttons',
              items: state.items,
              itemIndex: state.itemIndex,
              buttonIndex: state.buttonIndex,
            },
          }
        }
        return {
          state: {
            screen: 'pressing',
            items: state.items,
            itemIndex: state.itemIndex,
            item,
            button,
          },
          effect: {
            type: 'PRESS',
            req: {
              bot: item.bot,
              msgId: item.msgId,
              dataB64: button.dataB64,
              confirmedDanger: true,
            },
          },
        }
      }

      if (state.screen === 'result' || state.screen === 'refusal') {
        return {
          state: returnToQueue(state.items, state.itemIndex, meta.allowlistCount, meta.mode),
          effect: { type: 'REFRESH' },
        }
      }

      return { state }
    }

    case 'PRESS_DONE': {
      if (state.screen !== 'pressing') return { state }
      const { outcome, now } = action
      if (!outcome.ok) {
        if (outcome.code === 'PASSWORD_REQUIRED') {
          return {
            state: {
              screen: 'refusal',
              items: state.items,
              itemIndex: state.itemIndex,
              reason: 'requires_password',
              bot: state.item.bot,
              buttonLabel: state.button.label,
              headline: '2FA button - open Telegram',
              detail: outcome.message,
              shownAt: now,
            },
          }
        }
        if (outcome.code === 'BOT_NOT_ALLOWLISTED') {
          return {
            state: {
              screen: 'refusal',
              items: state.items,
              itemIndex: state.itemIndex,
              reason: 'not_allowlisted',
              bot: state.item.bot,
              buttonLabel: state.button.label,
              headline: 'Not on allowlist',
              detail: outcome.message,
              shownAt: now,
            },
          }
        }
        return {
          state: {
            screen: 'result',
            items: state.items,
            itemIndex: state.itemIndex,
            bot: state.item.bot,
            buttonLabel: state.button.label,
            headline: 'Action failed',
            detail: outcome.message,
            timedOut: false,
            shownAt: now,
          },
          effect: { type: 'REFRESH' },
        }
      }

      const detail = outcome.timedOut
        ? 'Bot did not answer (logged)'
        : outcome.editedLine || outcome.answer || 'Confirmed'

      return {
        state: {
          screen: 'result',
          items: state.items,
          itemIndex: state.itemIndex,
          bot: outcome.bot,
          buttonLabel: outcome.buttonLabel,
          headline: outcome.timedOut ? 'Press logged' : outcome.answer || 'Done',
          detail,
          timedOut: outcome.timedOut,
          shownAt: now,
        },
        effect: { type: 'REFRESH' },
      }
    }

    case 'TICK': {
      if (state.screen === 'danger_confirm' && action.now - state.armedAt > DANGER_ARM_TIMEOUT_MS) {
        return {
          state: {
            screen: 'buttons',
            items: state.items,
            itemIndex: state.itemIndex,
            buttonIndex: state.buttonIndex,
          },
        }
      }
      if (
        (state.screen === 'result' || state.screen === 'refusal') &&
        action.now - state.shownAt >= RESULT_DISPLAY_MS
      ) {
        return {
          state: returnToQueue(state.items, state.itemIndex, meta.allowlistCount, meta.mode),
          effect: { type: 'REFRESH' },
        }
      }
      return { state }
    }
  }
}
