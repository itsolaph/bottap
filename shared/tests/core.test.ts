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
  assert.equal(normalizeBotHandle('@Uptime_Ops_Bot '), 'uptime_ops_bot')
  assert.equal(normalizeBotHandle('bad handle!'), null)
  assert.equal(normalizeBotHandle('ab'), null)
  assert.deepEqual(normalizeAllowlist(['@Alpha_Bot', 'alpha_bot', 'Beta_Bot', 'bad!']), [
    'alpha_bot',
    'beta_bot',
  ])
  assert.equal(isAllowlisted('@BETA_BOT', ['beta_bot']), true)
  assert.equal(isAllowlisted('promo_bot', ['beta_bot']), false)
})

test('sanitizeAlertLine strips emoji & URLs, keeps ops symbols, skips emoji-only headers', () => {
  const raw = '🚨🔥\nCPU > 90% on prod_eu_1 https://secret.internal/x\nSecond body line'
  const line = sanitizeAlertLine(raw)
  assert.equal(line, 'CPU > 90% on prod_eu_1')
  assert.ok(line.length <= 40)
  assert.equal(line.includes('https'), false)
  assert.equal(line.includes('Second'), false)
  assert.equal(line.includes('🚨'), false)
})

test('classifyInlineButton supports Layer 234 InlineButtonTypeCallback + dual-signal danger policy', () => {
  const ok = classifyInlineButton({
    typeName: 'InlineButtonTypeCallback',
    text: '✅ Approve Prod',
    data: new TextEncoder().encode('deploy:approve'),
    style: { bgDanger: true },
  })
  assert.ok(ok)
  assert.equal(ok.label, 'Approve Prod')
  assert.equal(ok.danger, true)
  assert.equal(ok.dangerSource, 'protocol')
  assert.equal(ok.requiresPassword, false)

  // Unstyled third-party bot with destructive label still triggers conservative lexical policy
  const policyDanger = classifyInlineButton({
    typeName: 'InlineButtonTypeCallback',
    text: 'Restart Prod',
    data: new TextEncoder().encode('ops:restart'),
  })
  assert.ok(policyDanger)
  assert.equal(policyDanger.danger, true)
  assert.equal(policyDanger.dangerSource, 'policy')

  // Benign unstyled button stays single-tap
  const benign = classifyInlineButton({
    typeName: 'InlineButtonTypeCallback',
    text: 'Ack',
    data: new TextEncoder().encode('ops:ack'),
  })
  assert.ok(benign)
  assert.equal(benign.danger, false)
  assert.equal(benign.dangerSource, undefined)

  // Non-callback Layer 234 & legacy buttons dropped strictly
  for (const dropped of [
    'InlineButtonTypeUrl',
    'InlineButtonTypeWebView',
    'InlineButtonTypeGame',
    'InlineButtonTypeBuy',
    'InlineButtonTypeSwitchInline',
    'InlineButtonTypeCopy',
    'InlineButtonTypeDisabled',
    'KeyboardButtonUrl',
    'KeyboardButtonWebView',
  ]) {
    assert.equal(
      classifyInlineButton({ typeName: dropped, text: 'Click', data: 'x' }),
      null,
      `${dropped} must be stripped`,
    )
  }
})

test('buildQueueItem drops non-allowlisted bots, counts stripped & overflow buttons, supports group chatPeer', () => {
  const denied = buildQueueItem(
    {
      botHandle: 'promo_bot',
      botTitle: 'Promo',
      msgId: 1,
      rawText: 'Free airdrop',
      sentAt: 1000,
      buttons: [{ typeName: 'InlineButtonTypeCallback', text: 'Claim', data: 'x' }],
    },
    ['uptime_ops_bot'],
  )
  assert.equal(denied, null)

  const item = buildQueueItem(
    {
      botHandle: 'uptime_ops_bot',
      botTitle: 'Uptime',
      chatPeer: '-1001999888777',
      chatTitle: 'Ops Alerts',
      msgId: 101,
      rawText: 'DB-02 disk 94%',
      sentAt: 1000,
      buttons: [
        { typeName: 'InlineButtonTypeCallback', text: 'Ack', data: 'ack' },
        { typeName: 'InlineButtonTypeUrl', text: 'Grafana', data: 'https://x' },
        { typeName: 'InlineButtonTypeCallback', text: 'B2', data: 'b2' },
        { typeName: 'InlineButtonTypeCallback', text: 'B3', data: 'b3' },
        { typeName: 'InlineButtonTypeCallback', text: 'B4', data: 'b4' },
        { typeName: 'InlineButtonTypeCallback', text: 'B5', data: 'b5' },
        { typeName: 'InlineButtonTypeCallback', text: 'B6', data: 'b6' },
        { typeName: 'InlineButtonTypeCallback', text: 'B7 overflow', data: 'b7' },
      ],
    },
    ['uptime_ops_bot'],
  )
  assert.ok(item)
  assert.equal(item.id, '-1001999888777:101')
  assert.equal(item.chatPeer, '-1001999888777')
  assert.equal(item.buttons.length, 6)
  assert.equal(item.hiddenNonCallbackCount, 1)
  assert.equal(item.hiddenOverflowCount, 1)
})

test('G2 reducer preserves focus by ID, ignores DOUBLE_TAP during pressing, disarms on edit, and marks failed results ok=false', () => {
  const deployItem: QueueItem = {
    id: 'deploy_gate_bot:202',
    bot: 'deploy_gate_bot',
    botTitle: 'Deploy Gate',
    chatPeer: 'deploy_gate_bot',
    msgId: 202,
    line: 'Release v2.14.0 ready',
    sentAt: 1000,
    hiddenNonCallbackCount: 0,
    hiddenOverflowCount: 0,
    buttons: [
      {
        kind: 'callback',
        label: 'Approve Prod',
        dataB64: btoa('approve:202'),
        danger: true,
        dangerSource: 'protocol',
        requiresPassword: false,
        style: 'danger',
      },
      {
        kind: 'callback',
        label: 'Rotate Key',
        dataB64: btoa('rotate:202'),
        danger: true,
        dangerSource: 'protocol',
        requiresPassword: true,
        style: 'danger',
      },
    ],
  }
  const newerItem: QueueItem = {
    ...deployItem,
    id: 'uptime_ops_bot:303',
    bot: 'uptime_ops_bot',
    chatPeer: 'uptime_ops_bot',
    msgId: 303,
    line: 'API-01 502 spike',
  }

  let { state } = reduceG2State(initialG2State(), {
    type: 'SYNC_OK',
    paired: true,
    mode: 'demo',
    allowlistCount: 2,
    items: [deployItem],
  })
  assert.equal(state.screen, 'queue')

  // New alert arrives at index 0 -> queue cursor follows deployItem by ID (moves to index 1)
  state = reduceG2State(state, {
    type: 'SYNC_OK',
    paired: true,
    mode: 'demo',
    allowlistCount: 2,
    items: [newerItem, deployItem],
  }).state
  assert.equal(state.screen, 'queue')
  assert.equal(state.cursor, 1)

  // Open buttons, tap danger -> arms + emits ARM_DANGER
  state = reduceG2State(state, { type: 'TAP', now: 10_000 }).state
  const armed = reduceG2State(state, { type: 'TAP', now: 11_000 })
  assert.equal(armed.state.screen, 'danger_confirm')
  assert.equal(armed.effect?.type, 'ARM_DANGER')

  // If alert text edits mid-arm -> SYNC_OK disarms safely
  const editedDeploy: QueueItem = { ...deployItem, line: 'Release v2.15.0 CHANGED' }
  const disarmedOnEdit = reduceG2State(armed.state, {
    type: 'SYNC_OK',
    paired: true,
    mode: 'demo',
    allowlistCount: 2,
    items: [newerItem, editedDeploy],
  })
  assert.equal(disarmedOnEdit.state.screen, 'queue')

  // Re-open, arm, confirm -> pressing; DOUBLE_TAP during pressing must NOT exit!
  const openAgain = reduceG2State(disarmedOnEdit.state, { type: 'FOCUS_ITEM', index: 1, openButtons: true }).state
  const arm2 = reduceG2State(openAgain, { type: 'TAP', now: 20_000 }).state
  const pressing = reduceG2State(arm2, { type: 'TAP', now: 21_000 })
  assert.equal(pressing.state.screen, 'pressing')
  const ignoredDouble = reduceG2State(pressing.state, { type: 'DOUBLE_TAP' })
  assert.equal(ignoredDouble.state.screen, 'pressing')
  assert.equal(ignoredDouble.effect, undefined)

  // Failed press produces ok=false with distinct headline ("Already handled")
  const failed = reduceG2State(pressing.state, {
    type: 'PRESS_DONE',
    now: 22_000,
    outcome: { ok: false, code: 'BUTTON_NOT_FOUND', message: 'Gone' },
  })
  assert.equal(failed.state.screen, 'result')
  if (failed.state.screen === 'result') {
    assert.equal(failed.state.ok, false)
    assert.equal(failed.state.headline, 'Already handled')
  }

  // Auto-returns after RESULT_DISPLAY_MS
  const after = reduceG2State(failed.state, { type: 'TICK', now: 22_000 + RESULT_DISPLAY_MS + 1 })
  assert.equal(after.state.screen, 'queue')

  // Expiry check still disarms
  const open3 = reduceG2State(after.state, { type: 'FOCUS_ITEM', index: 1, openButtons: true }).state
  const arm3 = reduceG2State(open3, { type: 'TAP', now: 30_000 }).state
  const exp = reduceG2State(arm3, { type: 'TICK', now: 30_000 + DANGER_ARM_TIMEOUT_MS + 1 })
  assert.equal(exp.state.screen, 'buttons')
})

test('formatRelativeAge formats seconds/minutes/hours/days', () => {
  assert.equal(formatRelativeAge(10_000, 35_000), 'now')
  assert.equal(formatRelativeAge(0, 180_000), '3m')
  assert.equal(formatRelativeAge(0, 7_200_000), '2h')
  assert.equal(formatRelativeAge(0, 172_800_000), '2d')
})
