import path from 'node:path'
import { DemoBotTransport } from './demo-transport.js'
import { MtprotoBotTransport } from './mtproto-transport.js'
import { createGatewayServer } from './server.js'
import { GatewayStore } from './store.js'

const args = new Set(process.argv.slice(2))
const mode = args.has('--demo') || process.env.BOTTAP_MODE === 'demo' ? 'demo' : 'live'
const host = process.env.BOTTAP_HOST || '0.0.0.0'
const port = Number(process.env.BOTTAP_PORT || 8788)
const dataDir = process.env.BOTTAP_DATA_DIR || path.resolve(process.cwd(), 'data')
const authToken = process.env.BOTTAP_TOKEN?.trim() || undefined
const corsOrigin = process.env.BOTTAP_CORS_ORIGIN || '*'
const staticDir = process.env.BOTTAP_STATIC_DIR?.trim() || undefined

const defaultAllowlist =
  process.env.BOTTAP_ALLOWLIST?.split(',').filter(Boolean) ??
  (mode === 'demo' ? ['uptime_ops_bot', 'deploy_gate_bot', 'vault_guard_bot'] : [])

const store = new GatewayStore(dataDir, defaultAllowlist)

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
