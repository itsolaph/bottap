import test from 'node:test'
import assert from 'node:assert/strict'
import { renderG2Frame } from '../src/g2-renderer.js'
import { buildQrSvgModel } from '../src/qr-svg.js'
import type { G2ViewState, QueueItem } from '@bottap/shared'

const sampleItem: QueueItem = {
  id: 'deploy_gate_bot:8209',
  bot: 'deploy_gate_bot',
  botTitle: 'Deploy Gate',
  msgId: 8209,
  line: 'Release v2.14.0 ready for prod-eu-1',
  sentAt: 1000,
  hiddenNonCallbackCount: 1,
  buttons: [
    {
      kind: 'callback',
      label: 'Approve Prod',
      dataB64: btoa('deploy:approve:8209'),
      danger: true,
      requiresPassword: false,
      style: 'danger',
    },
    {
      kind: 'callback',
      label: 'Rotate Key',
      dataB64: btoa('vault:rotate:9055'),
      danger: true,
      requiresPassword: true,
      style: 'danger',
    },
  ],
}

test('All G2 screens stay within 576x288 monochrome line and width budgets', () => {
  const states: G2ViewState[] = [
    { screen: 'loading' },
    { screen: 'offline', message: 'Connection refused' },
    { screen: 'unpaired', mode: 'live' },
    { screen: 'empty', allowlistCount: 2, mode: 'live' },
    { screen: 'queue', items: [sampleItem], cursor: 0 },
    { screen: 'buttons', items: [sampleItem], itemIndex: 0, buttonIndex: 0 },
    { screen: 'danger_confirm', items: [sampleItem], itemIndex: 0, buttonIndex: 0, armedAt: 5000 },
    { screen: 'pressing', items: [sampleItem], itemIndex: 0, item: sampleItem, button: sampleItem.buttons[0]! },
    {
      screen: 'result',
      items: [sampleItem],
      itemIndex: 0,
      bot: 'deploy_gate_bot',
      buttonLabel: 'Approve Prod',
      headline: 'Deploy approved',
      detail: 'Release v2.14.0 promoted to prod-eu-1',
      timedOut: false,
      shownAt: 6000,
    },
    {
      screen: 'refusal',
      items: [sampleItem],
      itemIndex: 0,
      reason: 'requires_password',
      bot: 'vault_guard_bot',
      buttonLabel: 'Rotate Key',
      headline: '2FA button - open Telegram',
      detail: 'Password-gated actions are blocked on G2',
      shownAt: 7000,
    },
  ]

  for (const s of states) {
    const frame = renderG2Frame(s, 600_000)
    const lines = frame.body.split('\n')
    assert.ok(lines.length <= 8, `${s.screen} exceeded 8 lines: ${lines.length}`)
    for (const line of lines) {
      assert.ok(line.length <= 44, `${s.screen} exceeded 44 chars: "${line}"`)
    }
    assert.ok(frame.footer.length <= 48, `${s.screen} footer too long: "${frame.footer}"`)
  }
})

test('danger_confirm shows PRESS AGAIN and refusal shows 2FA message', () => {
  const dangerFrame = renderG2Frame({
    screen: 'danger_confirm',
    items: [sampleItem],
    itemIndex: 0,
    buttonIndex: 0,
    armedAt: 5000,
  })
  assert.match(dangerFrame.body, /PRESS AGAIN/)

  const refusalFrame = renderG2Frame({
    screen: 'refusal',
    items: [sampleItem],
    itemIndex: 0,
    reason: 'requires_password',
    bot: 'vault_guard_bot',
    buttonLabel: 'Rotate Key',
    headline: '2FA button - open Telegram',
    detail: 'Blocked',
    shownAt: 5000,
  })
  assert.match(refusalFrame.body, /2FA button - open Telegram/)
})

test('buildQrSvgModel encodes Telegram QR login URIs with a 4-module quiet zone', () => {
  const model = buildQrSvgModel('tg://login?token=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA')
  assert.ok(model.size >= 37, `expected QR matrix with quiet zone >= 37, got ${model.size}`)
  assert.ok(model.moduleCount > 100, 'expected non-trivial dark modules')
  assert.match(model.pathData, /^M4 4h7v1h-7z/, 'top-left finder pattern must start at quiet-zone offset (4,4)')
})
