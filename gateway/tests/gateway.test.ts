import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Api } from 'teleproto'
import { buildQueueItem } from '@bottap/shared'
import { DemoBotTransport } from '../src/demo-transport.js'
import { extractInlineButtons } from '../src/mtproto-transport.js'
import { createGatewayServer } from '../src/server.js'
import { GatewayStore } from '../src/store.js'

async function withServer(
  fn: (baseUrl: string, store: GatewayStore, transport: DemoBotTransport) => Promise<void>,
  authToken?: string,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottap-gw-'))
  const store = new GatewayStore(dir, ['uptime_ops_bot', 'deploy_gate_bot', 'vault_guard_bot'])
  const transport = new DemoBotTransport(() => 1_763_900_000_000)
  const server = createGatewayServer({ transport, store, authToken })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await fn(`http://127.0.0.1:${port}`, store, transport)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('Real teleproto Layer 234 ReplyInlineMarkup parses KeyboardInlineButton, bgDanger, 2FA, and strips URL buttons', () => {
  const markup = new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardInlineButtonRow({
        buttons: [
          new Api.KeyboardInlineButton({
            text: 'Approve Prod',
            style: new Api.KeyboardButtonStyle({ bgDanger: true }),
            type: new Api.InlineButtonTypeCallback({
              data: Buffer.from('deploy:approve:8209'),
              requiresPassword: false,
            }),
          }),
          new Api.KeyboardInlineButton({
            text: 'Rotate Key',
            style: new Api.KeyboardButtonStyle({ bgDanger: true }),
            type: new Api.InlineButtonTypeCallback({
              data: Buffer.from('vault:rotate:9055'),
              requiresPassword: true,
            }),
          }),
          new Api.KeyboardInlineButton({
            text: 'Open Diff',
            type: new Api.InlineButtonTypeUrl({ url: 'https://ci.internal/diff/8209' }),
          }),
        ],
      }),
    ],
  })

  const rawButtons = extractInlineButtons(markup)
  assert.equal(rawButtons.length, 3)
  assert.equal(rawButtons[0]!.typeName, 'InlineButtonTypeCallback')
  assert.equal(rawButtons[0]!.style?.bgDanger, true)
  assert.equal(rawButtons[1]!.requiresPassword, true)
  assert.equal(rawButtons[2]!.typeName, 'InlineButtonTypeUrl')

  const item = buildQueueItem(
    {
      botHandle: 'deploy_gate_bot',
      botTitle: 'Deploy Gate',
      chatPeer: '-1001999888777',
      chatTitle: '#ops-alerts',
      msgId: 8209,
      rawText: '🚨 Release v2.14.0 ready for prod-eu-1\nDiff details in Telegram',
      sentAt: 1_763_900_000_000,
      buttons: rawButtons,
    },
    ['deploy_gate_bot'],
  )

  assert.ok(item)
  assert.equal(item.id, '-1001999888777:8209')
  assert.equal(item.line, 'Release v2.14.0 ready for prod-eu-1')
  assert.equal(item.hiddenNonCallbackCount, 1)
  assert.equal(item.buttons.length, 2)
  assert.equal(item.buttons[0]!.danger, true)
  assert.equal(item.buttons[0]!.dangerSource, 'protocol')
  assert.equal(item.buttons[1]!.requiresPassword, true)
})

test('GET /pending returns allowlisted callback buttons only and hides non-allowlisted bots + url/webview buttons', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/pending`)
    assert.equal(res.status, 200)
    const data = (await res.json()) as {
      items: Array<{
        bot: string
        chatPeer: string
        buttons: Array<{ label: string; danger: boolean; requiresPassword: boolean }>
        hiddenNonCallbackCount: number
      }>
      scanDiagnostics: unknown[]
    }

    assert.equal(data.items.length, 3)
    assert.deepEqual(data.scanDiagnostics, [])
    assert.equal(
      data.items.some((i) => i.bot === 'random_promo_bot'),
      false,
      'non-allowlisted bot must never appear',
    )

    const uptime = data.items.find((i) => i.bot === 'uptime_ops_bot')!
    assert.equal(uptime.buttons.length, 2)
    assert.equal(uptime.hiddenNonCallbackCount, 1) // Grafana URL stripped

    const deploy = data.items.find((i) => i.bot === 'deploy_gate_bot')!
    assert.equal(deploy.buttons[0]!.danger, true)
    assert.equal(deploy.hiddenNonCallbackCount, 1) // WebView stripped
  })
})

test('POST /press enforces bg_danger 409 double-press, non-consumption on mismatch, 2FA 403, allowlist 403, and tombstones', async () => {
  await withServer(async (baseUrl) => {
    // 1. Non-allowlisted bot refused with 403
    const blockedBot = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'random_promo_bot',
        msgId: 777,
        dataB64: Buffer.from('promo:claim:777').toString('base64'),
      }),
    })
    assert.equal(blockedBot.status, 403)
    assert.equal(((await blockedBot.json()) as { code: string }).code, 'BOT_NOT_ALLOWLISTED')

    // 2. 2FA requires_password button refused with 403
    const twoFa = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'vault_guard_bot',
        msgId: 9055,
        dataB64: Buffer.from('vault:rotate:9055').toString('base64'),
        confirmedDanger: true,
      }),
    })
    assert.equal(twoFa.status, 403)
    assert.equal(((await twoFa.json()) as { code: string }).code, 'PASSWORD_REQUIRED')

    // 3. bg_danger without server armToken returns 409 even when confirmedDanger=true
    const unconfirmedDanger = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'deploy_gate_bot',
        msgId: 8209,
        dataB64: Buffer.from('deploy:approve:8209').toString('base64'),
        confirmedDanger: true,
      }),
    })
    assert.equal(unconfirmedDanger.status, 409)
    assert.equal(
      ((await unconfirmedDanger.json()) as { code: string }).code,
      'DANGER_CONFIRMATION_REQUIRED',
    )

    // 4. Arming a non-danger button is rejected with 400
    const armSafe = await fetch(`${baseUrl}/arm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'deploy_gate_bot',
        msgId: 8209,
        dataB64: Buffer.from('deploy:hold:8209').toString('base64'),
      }),
    })
    assert.equal(armSafe.status, 400)

    // 5. Issue real armToken, verify wrong token returns 409 without burning real token, then confirm succeeds
    const armRes = await fetch(`${baseUrl}/arm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'deploy_gate_bot',
        msgId: 8209,
        dataB64: Buffer.from('deploy:approve:8209').toString('base64'),
      }),
    })
    assert.equal(armRes.status, 200)
    const { armToken } = (await armRes.json()) as { ok: boolean; armToken: string }
    assert.ok(armToken && armToken.length >= 16)

    const badTok = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'deploy_gate_bot',
        msgId: 8209,
        dataB64: Buffer.from('deploy:approve:8209').toString('base64'),
        confirmedDanger: true,
        armToken: 'not-a-valid-token',
      }),
    })
    assert.equal(badTok.status, 409)

    const confirmedDanger = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'deploy_gate_bot',
        msgId: 8209,
        dataB64: Buffer.from('deploy:approve:8209').toString('base64'),
        confirmedDanger: true,
        armToken,
      }),
    })
    assert.equal(confirmedDanger.status, 200)
    const ok = (await confirmedDanger.json()) as { ok: boolean; answer: string; editedLine: string }
    assert.equal(ok.ok, true)
    assert.equal(ok.answer, 'Deploy approved')
    assert.match(ok.editedLine, /promoted/)

    // Tombstone suppresses 8209 from /pending
    const pendingAfter = (await (await fetch(`${baseUrl}/pending`)).json()) as {
      items: Array<{ bot: string; msgId: number }>
    }
    assert.equal(
      pendingAfter.items.some((i) => i.bot === 'deploy_gate_bot' && i.msgId === 8209),
      false,
    )

    // 6. BOT_RESPONSE_TIMEOUT returns 200 with timedOut=true and logs press
    const timeoutRes = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'vault_guard_bot',
        msgId: 9055,
        dataB64: Buffer.from('vault:defer:9055').toString('base64'),
      }),
    })
    assert.equal(timeoutRes.status, 200)
    assert.equal(((await timeoutRes.json()) as { timedOut: boolean }).timedOut, true)
  })
})

test('Allowlist and ops groups CRUD write audit entries and /health respects proxy fail-closed boundary', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`)
    assert.equal(health.status, 200)
    const hJson = (await health.json()) as { ok: boolean; mode: string; tokenRequired: boolean }
    assert.deepEqual(hJson, { ok: true, mode: 'demo', tokenRequired: false })

    const proxiedHealth = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    })
    assert.equal(proxiedHealth.status, 403)

    const addGroup = await fetch(`${baseUrl}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: '-1001999888777' }),
    })
    assert.equal(addGroup.status, 200)
    assert.deepEqual(((await addGroup.json()) as { groups: string[] }).groups, ['-1001999888777'])

    const rmGroup = await fetch(`${baseUrl}/groups/${encodeURIComponent('-1001999888777')}`, {
      method: 'DELETE',
    })
    assert.equal(rmGroup.status, 200)
    assert.deepEqual(((await rmGroup.json()) as { groups: string[] }).groups, [])

    const addBot = await fetch(`${baseUrl}/allowlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: '@pager_ops_bot' }),
    })
    assert.equal(addBot.status, 200)

    const status = (await (await fetch(`${baseUrl}/status`)).json()) as {
      recentAudit: Array<{ outcome: string; bot: string }>
    }
    assert.ok(
      status.recentAudit.some((e) => e.outcome === 'allowlist_add' && e.bot === 'pager_ops_bot'),
      'allowlist mutation must be audited',
    )
  })
})

test('Gateway exposes zero read-chat or send-message endpoints, blocks untrusted origins, and enforces Bearer token', async () => {
  await withServer(async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/pending`)
    assert.equal(unauth.status, 401)
    assert.equal(
      unauth.headers.get('access-control-allow-origin'),
      null,
      'must not emit wildcard CORS by default',
    )

    const crossOriginPost = await fetch(`${baseUrl}/press`, {
      method: 'POST',
      headers: {
        Origin: 'https://untrusted.example',
        Authorization: 'Bearer secret-test-tok',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bot: 'uptime_ops_bot', msgId: 4101, dataB64: 'dGVzdA==' }),
    })
    assert.equal(crossOriginPost.status, 403)

    for (const forbiddenRoute of ['/chats', '/messages', '/dialogs', '/send']) {
      const r = await fetch(`${baseUrl}${forbiddenRoute}`, {
        headers: { Authorization: 'Bearer secret-test-tok' },
      })
      assert.equal(r.status, 404, `${forbiddenRoute} must not exist`)
    }
  }, 'secret-test-tok')
})

test('Tokenless loopback gateway blocks proxy headers', async () => {
  await withServer(async (baseUrl) => {
    const proxied = await fetch(`${baseUrl}/pending`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    })
    assert.equal(proxied.status, 403)
    assert.equal(((await proxied.json()) as { code: string }).code, 'TOKEN_REQUIRED_FOR_PROXY')
  })
})
