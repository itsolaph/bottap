export type TelegramButtonStyle = 'primary' | 'success' | 'danger'

export interface TelegramInlineButton {
  readonly text: string
  readonly callback_data?: string
  readonly url?: string
  readonly style?: TelegramButtonStyle
}

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<TelegramInlineButton>>
}

export interface AlertMessageSpec {
  readonly scenario: 'uptime' | 'deploy' | 'slow'
  readonly text: string
  readonly reply_markup: TelegramInlineKeyboardMarkup
}

export interface CallbackResolution {
  readonly answerText: string
  readonly editedText: string | null
  readonly removeKeyboard: boolean
  readonly simulateTimeout: boolean
}

export function buildUptimeAlert(): AlertMessageSpec {
  return {
    scenario: 'uptime',
    text: 'API-01 502 spike on /health (3/3 probes)\nLatency p99 4.8s across edge nodes.',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Ack', callback_data: 'uptime:ack', style: 'success' },
          { text: 'Mute 1h', callback_data: 'uptime:mute1h' },
        ],
        [
          { text: 'Open Status Page', url: 'https://example.org/status' },
        ],
      ],
    },
  }
}

export function buildDeployAlert(): AlertMessageSpec {
  return {
    scenario: 'deploy',
    text: 'Release v2.14.0 ready for prod-eu-1\nPipeline #8209 green (42/42 checks).',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Approve Prod', callback_data: 'deploy:approve', style: 'danger' },
          { text: 'Hold', callback_data: 'deploy:hold' },
        ],
        [
          { text: 'Inspect Release', url: 'https://example.org/releases/v2.14.0' },
        ],
      ],
    },
  }
}

export function buildSlowAlert(): AlertMessageSpec {
  return {
    scenario: 'slow',
    text: 'Worker queue drain check (slow webhook)\nSkips callback answer to exercise timeout handling.',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Drain Now', callback_data: 'slow:drain' },
        ],
      ],
    },
  }
}

export function stripButtonStyles(markup: TelegramInlineKeyboardMarkup): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map(({ style: _omitted, ...rest }) => rest),
    ),
  }
}

export function buildHelpText(): string {
  return [
    'BotTap Live Demo Bot',
    '',
    'Send a command to generate real inline callback alerts:',
    '/uptime - Service alert with Ack (success), Mute 1h, and a stripped URL button',
    '/deploy - Deploy gate with Approve Prod (style=danger -> double-press on G2) and Hold',
    '/slow   - Unanswered callback to verify BOT_RESPONSE_TIMEOUT handling',
    '/all    - Send all three operational alerts at once',
  ].join('\n')
}

export function resolveCallbackAction(data: string, actor: string): CallbackResolution {
  const who = actor.trim() || 'on-call'
  switch (data) {
    case 'uptime:ack':
      return {
        answerText: 'Alert acknowledged',
        editedText: `Acked by ${who} · API-01`,
        removeKeyboard: true,
        simulateTimeout: false,
      }
    case 'uptime:mute1h':
      return {
        answerText: 'Silenced for 60m',
        editedText: `Muted 1h by ${who} · API-01`,
        removeKeyboard: true,
        simulateTimeout: false,
      }
    case 'deploy:approve':
      return {
        answerText: 'Deploy approved',
        editedText: `Release v2.14.0 promoted to prod-eu-1 (${who})`,
        removeKeyboard: true,
        simulateTimeout: false,
      }
    case 'deploy:hold':
      return {
        answerText: 'Deploy held',
        editedText: `Release v2.14.0 held by ${who}`,
        removeKeyboard: true,
        simulateTimeout: false,
      }
    case 'slow:drain':
      return {
        answerText: '',
        editedText: null,
        removeKeyboard: false,
        simulateTimeout: true,
      }
    default:
      return {
        answerText: 'Unknown callback action',
        editedText: null,
        removeKeyboard: false,
        simulateTimeout: false,
      }
  }
}
