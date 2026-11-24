import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DemoBotTransport } from '../src/demo-transport.js'
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

test('GET /pending returns allowlisted callback buttons only and hides non-allowlisted bots + url/webview buttons', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/pending`)
    assert.equal(res.status, 200)
    const data = (await res.json()) as {
      items: Array<{ bot: string; buttons: Array<{ label: string; danger: boolean; requiresPassword: boolean }>; hiddenNonCallbackCount: number }>
    }

    assert.equal(data.items.length, 3)
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

test('POST /press enforces bg_danger 409 double-press, 2FA 403 refusal, and allowlist 403 block', async () => {
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

    // 4. Two-step server-issued armToken + confirmedDanger=true succeeds and consumes token
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

    // 5. BOT_RESPONSE_TIMEOUT returns 200 with timedOut=true and logs press
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

test('Gateway exposes zero read-chat or send-message endpoints, blocks untrusted origins, and enforces Bearer token', async () => {
  await withServer(async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/pending`)
    assert.equal(unauth.status, 401)
    assert.equal(unauth.headers.get('access-control-allow-origin'), null, 'must not emit wildcard CORS by default')

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

test('Tokenless loopback gateway blocks proxy headers and DNS-rebinding Host headers', async () => {
  await withServer(async (baseUrl) => {
    const proxied = await fetch(`${baseUrl}/pending`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    })
    assert.equal(proxied.status, 403)
    assert.equal(((await proxied.json()) as { code: string }).code, 'TOKEN_REQUIRED_FOR_PROXY')
  })
})
