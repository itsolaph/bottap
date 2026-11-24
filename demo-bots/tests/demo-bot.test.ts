import test from 'node:test'
import assert from 'node:assert/strict'
import { TelegramBotApiClient, processUpdate } from '../src/bot-api.js'
import {
  buildDeployAlert,
  buildSlowAlert,
  buildUptimeAlert,
  stripButtonStyles,
} from '../src/scenarios.js'

test('Alert builders emit real callback buttons, bg_danger style, and stripped URL buttons', () => {
  const uptime = buildUptimeAlert()
  const deploy = buildDeployAlert()
  const slow = buildSlowAlert()

  assert.equal(uptime.reply_markup.inline_keyboard[0]![0]!.style, 'success')
  assert.ok(uptime.reply_markup.inline_keyboard[1]![0]!.url, 'uptime alert includes a URL button')

  assert.equal(deploy.reply_markup.inline_keyboard[0]![0]!.style, 'danger')
  assert.equal(deploy.reply_markup.inline_keyboard[0]![0]!.callback_data, 'deploy:approve')
  assert.ok(deploy.reply_markup.inline_keyboard[1]![0]!.url, 'deploy alert includes a URL button')

  assert.equal(slow.reply_markup.inline_keyboard[0]![0]!.callback_data, 'slow:drain')

  const stripped = stripButtonStyles(deploy.reply_markup)
  assert.equal(stripped.inline_keyboard[0]![0]!.style, undefined)
  assert.equal(stripped.inline_keyboard[0]![0]!.callback_data, 'deploy:approve')
})

test('processUpdate answers callback and edits message on deploy:approve, and omits answer on slow:drain', async () => {
  const calls: Array<{ method: string; payload?: Record<string, unknown> }> = []
  const alerts: string[] = []
  const fakeApi = {
    async call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
      calls.push({ method, payload })
      return {} as T
    },
    async sendAlert(_chatId: number, spec: { scenario: string }) {
      alerts.push(spec.scenario)
      return { message_id: 1, chat: { id: 100 } }
    },
  }

  await processUpdate(fakeApi, {
    update_id: 1,
    message: { message_id: 10, chat: { id: 42 }, text: '/all' },
  })
  assert.deepEqual(alerts, ['uptime', 'deploy', 'slow'])

  await processUpdate(fakeApi, {
    update_id: 2,
    callback_query: {
      id: 'cq-1',
      from: { id: 7, username: 'oncall_ops' },
      message: { message_id: 11, chat: { id: 42 } },
      data: 'deploy:approve',
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'answerCallbackQuery')
  assert.equal(calls[0]!.payload?.text, 'Deploy approved')
  assert.equal(calls[1]!.method, 'editMessageText')
  assert.match(String(calls[1]!.payload?.text), /promoted to prod-eu-1 \(@oncall_ops\)/)

  calls.length = 0
  await processUpdate(fakeApi, {
    update_id: 3,
    callback_query: {
      id: 'cq-2',
      from: { id: 7, username: 'oncall_ops' },
      message: { message_id: 12, chat: { id: 42 } },
      data: 'slow:drain',
    },
  })
  assert.equal(calls.length, 0, 'slow:drain must intentionally omit answerCallbackQuery')
})

test('TelegramBotApiClient.sendAlert retries without button style on HTTP 400 fallback', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(parsed)
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: unknown button style' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 1 } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const api = new TelegramBotApiClient('123:test', mockFetch)
  const sent = await api.sendAlert(1, buildDeployAlert())
  assert.equal(sent.message_id, 99)
  assert.equal(bodies.length, 2)

  const firstRow = (bodies[0]!.reply_markup as { inline_keyboard: Array<Array<{ style?: string }>> }).inline_keyboard[0]!
  const retryRow = (bodies[1]!.reply_markup as { inline_keyboard: Array<Array<{ style?: string }>> }).inline_keyboard[0]!
  assert.equal(firstRow[0]!.style, 'danger')
  assert.equal(retryRow[0]!.style, undefined)
})
