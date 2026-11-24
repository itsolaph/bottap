import { TelegramBotApiClient, processUpdate, type TelegramUpdate } from './bot-api.js'

const token = (process.env.DEMO_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim()
if (!token) {
  console.error('[bottap-demo-bot] Set DEMO_BOT_TOKEN in your environment (create a bot via @BotFather).')
  process.exit(1)
}

const api = new TelegramBotApiClient(token)
let running = true
let offset = 0

process.on('SIGINT', () => {
  running = false
})
process.on('SIGTERM', () => {
  running = false
})

const me = await api.call<{ username?: string; first_name?: string }>('getMe')
const handle = me.username ? `@${me.username}` : me.first_name || 'demo-bot'
console.log(`[bottap-demo-bot] connected as ${handle}; send /all, /uptime, /deploy, or /slow in Telegram`)

while (running) {
  try {
    const updates = await api.call<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message', 'callback_query'],
    })
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1)
      await processUpdate(api, update)
    }
  } catch (err) {
    if (!running) break
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[bottap-demo-bot] polling error: ${msg}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

console.log('[bottap-demo-bot] stopped')
