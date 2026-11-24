import {
  buildDeployAlert,
  buildHelpText,
  buildSlowAlert,
  buildUptimeAlert,
  resolveCallbackAction,
  stripButtonStyles,
  type AlertMessageSpec,
} from './scenarios.js'

export interface TelegramUser {
  readonly id: number
  readonly username?: string
  readonly first_name?: string
}

export interface TelegramMessage {
  readonly message_id: number
  readonly chat: { readonly id: number }
  readonly from?: TelegramUser
  readonly text?: string
}

export interface TelegramCallbackQuery {
  readonly id: string
  readonly from: TelegramUser
  readonly message?: TelegramMessage
  readonly data?: string
}

export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
  readonly callback_query?: TelegramCallbackQuery
}

export interface TelegramApiError extends Error {
  readonly status: number
  readonly description: string
}

export class TelegramBotApiClient {
  private readonly baseUrl: string

  constructor(
    token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    apiOrigin = 'https://api.telegram.org',
  ) {
    this.baseUrl = `${apiOrigin.replace(/\/+$/, '')}/bot${token}`
  }

  async call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })
    const body = (await res.json()) as {
      ok: boolean
      result?: T
      description?: string
      error_code?: number
    }
    if (!res.ok || !body.ok) {
      const err = new Error(body.description || `Telegram API HTTP ${res.status}`) as TelegramApiError & {
        status: number
        description: string
      }
      err.status = body.error_code ?? res.status
      err.description = body.description ?? `HTTP ${res.status}`
      throw err
    }
    return body.result as T
  }

  async sendAlert(chatId: number, spec: AlertMessageSpec): Promise<TelegramMessage> {
    try {
      return await this.call<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: spec.text,
        reply_markup: spec.reply_markup,
      })
    } catch (err) {
      const status = (err as Partial<TelegramApiError>).status
      const desc = (err as Partial<TelegramApiError>).description ?? ''
      if (status === 400 && /style|keyboard|bad request/i.test(desc)) {
        return this.call<TelegramMessage>('sendMessage', {
          chat_id: chatId,
          text: spec.text,
          reply_markup: stripButtonStyles(spec.reply_markup),
        })
      }
      throw err
    }
  }
}

function formatActor(user?: TelegramUser): string {
  if (!user) return 'on-call'
  if (user.username) return `@${user.username}`
  return user.first_name || 'on-call'
}

export async function processUpdate(
  api: Pick<TelegramBotApiClient, 'call' | 'sendAlert'>,
  update: TelegramUpdate,
): Promise<void> {
  if (update.message?.text) {
    const chatId = update.message.chat.id
    const command = update.message.text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase()
    if (command === '/start' || command === '/help') {
      await api.call('sendMessage', { chat_id: chatId, text: buildHelpText() })
      return
    }
    if (command === '/uptime') {
      await api.sendAlert(chatId, buildUptimeAlert())
      return
    }
    if (command === '/deploy') {
      await api.sendAlert(chatId, buildDeployAlert())
      return
    }
    if (command === '/slow') {
      await api.sendAlert(chatId, buildSlowAlert())
      return
    }
    if (command === '/all') {
      await api.sendAlert(chatId, buildUptimeAlert())
      await api.sendAlert(chatId, buildDeployAlert())
      await api.sendAlert(chatId, buildSlowAlert())
      return
    }
    return
  }

  if (update.callback_query) {
    const cq = update.callback_query
    const resolution = resolveCallbackAction(cq.data ?? '', formatActor(cq.from))
    if (resolution.simulateTimeout) {
      // Intentionally omit answerCallbackQuery so Telegram emits BOT_RESPONSE_TIMEOUT
      return
    }
    await api.call('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: resolution.answerText,
      show_alert: false,
    })
    if (resolution.editedText && cq.message) {
      await api.call('editMessageText', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: resolution.editedText,
        reply_markup: resolution.removeKeyboard ? { inline_keyboard: [] } : undefined,
      })
    }
  }
}
