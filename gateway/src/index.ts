import path from 'node:path'
import { DemoBotTransport } from './demo-transport.js'
import { MtprotoBotTransport } from './mtproto-transport.js'
import { createGatewayServer } from './server.js'
import { GatewayStore } from './store.js'

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

const args = new Set(process.argv.slice(2))
const mode = args.has('--demo') || process.env.BOTTAP_MODE === 'demo' ? 'demo' : 'live'
const host = process.env.BOTTAP_HOST || '127.0.0.1'
const port = Number(process.env.BOTTAP_PORT || 8788)
const dataDir = process.env.BOTTAP_DATA_DIR || path.resolve(process.cwd(), 'data')
const authToken = process.env.BOTTAP_TOKEN?.trim() || undefined
const corsOrigin = process.env.BOTTAP_CORS_ORIGIN?.trim() || ''
const staticDir = process.env.BOTTAP_STATIC_DIR?.trim() || undefined

if (mode === 'live' && !isLoopbackHost(host) && !authToken) {
  console.error(
    '[bottap-gateway] Refusing to bind live gateway on non-loopback host without BOTTAP_TOKEN. Set BOTTAP_TOKEN (>= 12 chars) in .env or bind BOTTAP_HOST=127.0.0.1 behind an HTTPS proxy.',
  )
  process.exit(1)
}
if (authToken && authToken.length < 12) {
  console.error('[bottap-gateway] BOTTAP_TOKEN must be at least 12 characters long.')
  process.exit(1)
}

const defaultAllowlist =
  process.env.BOTTAP_ALLOWLIST?.split(',').filter(Boolean) ??
  (mode === 'demo' ? ['uptime_ops_bot', 'deploy_gate_bot', 'vault_guard_bot'] : [])
const defaultGroups = process.env.BOTTAP_GROUPS?.split(',').filter(Boolean) ?? []

const store = new GatewayStore(dataDir, defaultAllowlist, defaultGroups)

const transport =
  mode === 'demo'
    ? new DemoBotTransport()
    : new MtprotoBotTransport(
        {
          apiId: Number(process.env.TG_API_ID || 0),
          apiHash: (process.env.TG_API_HASH || '').trim(),
        },
        store,
      )

await transport.init()

const server = createGatewayServer({
  transport,
  store,
  authToken,
  corsOrigin,
  staticDir,
})

server.listen(port, host, () => {
  const pairing = transport.getPairingState()
  console.log(
    `[bottap-gateway] listening on http://${host}:${port} (mode=${mode}, status=${pairing.status}, allowlist=${store.getAllowlist().length})`,
  )
})

const shutdown = async () => {
  server.close()
  await transport.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
