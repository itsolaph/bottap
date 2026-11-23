import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueueItem,
  classifyInlineButton,
  DANGER_ARM_TIMEOUT_MS,
  formatRelativeAge,
  initialG2State,
  isAllowlisted,
  normalizeAllowlist,
  normalizeBotHandle,
  reduceG2State,
  RESULT_DISPLAY_MS,
  sanitizeAlertLine,
  type QueueItem,
} from '../src/index.js'

test('normalizeBotHandle & allowlist enforce strict lowercase handles', () => {
  assert.equal(normalizeBotHandle('  @Uptime_Ops_Bot '), 'uptime_ops_bot')
  assert.equal(normalizeBotHandle('bad handle!'), null)
  assert.equal(normalizeBotHandle('ab'), null)
  assert.deepEqual(normalizeAllowlist(['@Alpha_Bot', 'alpha_bot', 'Beta_Bot', 'x']), [
    'alpha_bot',
    'beta_bot',
  ])
  assert.equal(isAllowlisted('@ALPHA_BOT', ['alpha_bot']), true)
  assert.equal(isAllowlisted('stranger_bot', ['alpha_bot']), false)
})

test('sanitizeAlertLine extracts only first alert line <= 40 chars and strips URLs/bodies', () => {
  const multi =
    '  **ALERT** prod-eu-west-1 latency > 2400ms https://secret.example/x\nFull stack trace body should never leak onto glasses!'
  const line = sanitizeAlertLine(multi)
  assert.ok(line.length <= 40, `expected <=40, got ${line.length}: ${line}`)
  assert.equal(line.includes('stack trace'), false)
  assert.equal(line.includes('https://'), false)
  assert.equal(line.includes('\n'), false)
})

test('classifyInlineButton keeps only KeyboardButtonCallback and drops url/web_app/game/copy', () => {
  const ok = classifyInlineButton({
    typeName: 'KeyboardButtonCallback',
    text: 'Approve Release',
    data: new TextEncoder().encode('deploy:approve:42'),
    style: { bgDanger: true },
  })
  assert.ok(ok)
  assert.equal(ok.danger, true)
  assert.equal(ok.requiresPassword, false)
  assert.equal(ok.style, 'danger')

  const twoFa = classifyInlineButton({
    typeName: 'KeyboardButtonCallback',
    text: 'Rotate Key',
    data: 'vault:rotate',
    requiresPassword: true,
  })
  assert.ok(twoFa)
  assert.equal(twoFa.requiresPassword, true)

  for (const droppedType of [
    'KeyboardButtonUrl',
    'KeyboardButtonWebView',
    'KeyboardButtonSimpleWebView',
    'KeyboardButtonGame',
    'KeyboardButtonBuy',
    'KeyboardButtonSwitchInline',
    'KeyboardButtonCopy',
  ]) {
    assert.equal(
      classifyInlineButton({ typeName: droppedType, text: 'Open', data: 'x' }),
      null,
      `expected ${droppedType} to be stripped`,
    )
  }
})

test('buildQueueItem drops non-allowlisted bots and counts stripped non-callback buttons', () => {
  const denied = buildQueueItem(
    {
      botHandle: 'unknown_bot',
      botTitle: 'Unknown',
      msgId: 10,
      rawText: 'Spam alert',
      sentAt: 1000,
      buttons: [{ typeName: 'KeyboardButtonCallback', text: 'Click', data: 'x' }],
    },
    ['uptime_ops_bot'],
  )
  assert.equal(denied, null)

  const item = buildQueueItem(
    {
      botHandle: '@Uptime_Ops_Bot',
      botTitle: 'Uptime Ops',
      msgId: 101,
      rawText: 'API-01 502 error on /health\nSecond line hidden',
      sentAt: 1000,
      buttons: [
        { typeName: 'KeyboardButtonCallback', text: 'Ack', data: 'ack:101' },
        { typeName: 'KeyboardButtonUrl', text: 'Dashboard', data: 'https://x' },
        { typeName: 'KeyboardButtonWebView', text: 'Open Mini App', data: 'x' },
      ],
    },
    ['uptime_ops_bot'],
  )
  assert.ok(item)
  assert.equal(item.buttons.length, 1)
  assert.equal(item.hiddenNonCallbackCount, 2)
  assert.equal(item.line, 'API-01 502 error on /health')
})

test('G2 reducer enforces danger double-press, 6s arm timeout, 2FA refusal, and 2s result auto-return', () => {
  const items: QueueItem[] = [
    {
      id: 'deploy_gate_bot:202',
      bot: 'deploy_gate_bot',
      botTitle: 'Deploy Gate',
      msgId: 202,
      line: 'Release v2.14.0 -> prod-main',
      sentAt: 1000,
      hiddenNonCallbackCount: 0,
      buttons: [
        {
          kind: 'callback',
          label: 'Approve',
          dataB64: btoa('approve:202'),
          danger: true,
          requiresPassword: false,
          style: 'danger',
        },
        {
          kind: 'callback',
          label: 'Rotate 2FA Key',
          dataB64: btoa('rotate:202'),
          danger: false,
          requiresPassword: true,
          style: 'default',
        },
      ],
    },
  ]

  let { state } = reduceG2State(initialG2State(), {
    type: 'SYNC_OK',
    paired: true,
    mode: 'demo',
    allowlistCount: 1,
    items,
  })
  assert.equal(state.screen, 'queue')

  // Tap enters buttons screen
  state = reduceG2State(state, { type: 'TAP', now: 10_000 }).state
  assert.equal(state.screen, 'buttons')

  // First tap on bg_danger arms confirmation without sending PRESS effect
  const armed = reduceG2State(state, { type: 'TAP', now: 11_000 })
  assert.equal(armed.state.screen, 'danger_confirm')
  assert.equal(armed.effect, undefined)

  // Expiry disarms cleanly
  const expired = reduceG2State(armed.state, {
    type: 'TICK',
    now: 11_000 + DANGER_ARM_TIMEOUT_MS + 1,
  })
  assert.equal(expired.state.screen, 'buttons')

  // Re-arm and confirm within window -> sends PRESS with confirmedDanger: true
  const rearmed = reduceG2State(expired.state, { type: 'TAP', now: 20_000 })
  const confirmed = reduceG2State(rearmed.state, { type: 'TAP', now: 21_500 })
  assert.equal(confirmed.state.screen, 'pressing')
  assert.deepEqual(confirmed.effect, {
    type: 'PRESS',
    req: {
      bot: 'deploy_gate_bot',
      msgId: 202,
      dataB64: btoa('approve:202'),
      confirmedDanger: true,
    },
  })

  // Press done shows result and returns to queue after RESULT_DISPLAY_MS
  const done = reduceG2State(confirmed.state, {
    type: 'PRESS_DONE',
    now: 22_000,
    outcome: {
      ok: true,
      bot: 'deploy_gate_bot',
      msgId: 202,
      buttonLabel: 'Approve',
      answer: 'Release promoted',
      editedLine: 'v2.14.0 approved by on-call',
      timedOut: false,
      pressedAt: 22_000,
    },
  })
  assert.equal(done.state.screen, 'result')

  const returned = reduceG2State(
    done.state,
    { type: 'TICK', now: 22_000 + RESULT_DISPLAY_MS },
    { allowlistCount: 1, mode: 'demo' },
  )
  assert.equal(returned.state.screen, 'queue')

  // Selecting 2FA button refuses immediately without PRESS effect
  let s2 = reduceG2State(returned.state, { type: 'TAP', now: 30_000 }).state
  s2 = reduceG2State(s2, { type: 'SCROLL_DOWN' }).state
  const refused = reduceG2State(s2, { type: 'TAP', now: 30_500 })
  assert.equal(refused.state.screen, 'refusal')
  assert.equal(refused.effect, undefined)
  if (refused.state.screen === 'refusal') {
    assert.equal(refused.state.headline, '2FA button - open Telegram')
  }

  // Double-tap on root queue exits glasses app cleanly
  const exit = reduceG2State(returned.state, { type: 'DOUBLE_TAP' })
  assert.deepEqual(exit.effect, { type: 'SHUTDOWN_G2' })
})

test('formatRelativeAge formats seconds/minutes/hours/days', () => {
  assert.equal(formatRelativeAge(10_000, 35_000), 'now')
  assert.equal(formatRelativeAge(0, 5 * 60_000), '5m')
  assert.equal(formatRelativeAge(0, 3 * 3600_000), '3h')
  assert.equal(formatRelativeAge(0, 2 * 86400_000), '2d')
})
