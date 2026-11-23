import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import {
  buildQueueItem,
  decodeBase64ToBytes,
  isAllowlisted,
  normalizeBotHandle,
  sanitizeAlertLine,
  type AuditOutcome,
  type GatewayStatus,
  type PendingResponse,
  type PressOutcome,
  type PressRequest,
  type QueueItem,
} from '@bottap/shared'
import type { GatewayStore } from './store.js'
import type { BotTransport } from './transport.js'

const MAX_BODY_BYTES = 16 * 1024

export interface GatewayServerOptions {
  readonly transport: BotTransport
  readonly store: GatewayStore
  readonly authToken?: string
  readonly corsOrigin?: string
  readonly staticDir?: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

function sendJson(res: ServerResponse, status: number, body: unknown, corsOrigin: string): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  })
  res.end(payload)
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({} as T)
        return
      }
      try {
        resolve(JSON.parse(raw) as T)
      } catch {
        reject(new Error('INVALID_JSON'))
      }
    })
    req.on('error', reject)
  })
}

function verifyBearer(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7).trim())
  const expected = Buffer.from(expectedToken)
  if (supplied.length !== expected.length) return false
  return crypto.timingSafeEqual(supplied, expected)
}

function tryServeStatic(staticDir: string, reqPath: string, res: ServerResponse): boolean {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '')
  const resolvedRoot = path.resolve(staticDir)
  const candidate = path.resolve(resolvedRoot, cleanRel)
  if (!candidate.startsWith(resolvedRoot + path.sep) && candidate !== path.join(resolvedRoot, 'index.html')) {
    return false
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return false
  }
  const ext = path.extname(candidate).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  fs.createReadStream(candidate).pipe(res)
  return true
}

export function createGatewayServer(options: GatewayServerOptions): http.Server {
  const corsOrigin = options.corsOrigin || '*'
  const { transport, store } = options

  const logAudit = (
    bot: string,
    msgId: number,
    buttonLabel: string,
    outcome: AuditOutcome,
    detail: string,
  ) => {
    store.appendAudit({
      id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      at: Date.now(),
      bot,
      msgId,
      buttonLabel,
      outcome,
      detail: sanitizeAlertLine(detail, 64),
    })
  }

  const getFilteredQueue = async (): Promise<QueueItem[]> => {
    const allowlist = store.getAllowlist()
    const rawItems = await transport.scanPending(allowlist)
    const items: QueueItem[] = []
    for (const raw of rawItems) {
      const built = buildQueueItem(raw, allowlist)
      if (built) items.push(built)
    }
    return items
  }

  return http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET'
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = parsed.pathname

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        })
        res.end()
        return
      }

      if (method === 'GET' && pathname === '/health') {
        sendJson(
          res,
          200,
          {
            ok: true,
            mode: transport.mode,
            paired: transport.getPairingState().status === 'paired',
          },
          corsOrigin,
        )
        return
      }

      // Static companion UI assets (no auth required for HTML/JS/CSS shell)
      if (method === 'GET' && options.staticDir && !pathname.startsWith('/pending') && !pathname.startsWith('/status') && !pathname.startsWith('/allowlist') && !pathname.startsWith('/pairing')) {
        if (tryServeStatic(options.staticDir, pathname, res)) {
          return
        }
      }

      if (!verifyBearer(req, options.authToken)) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Valid Bearer token required' }, corsOrigin)
        return
      }

      if (method === 'GET' && pathname === '/status') {
        const pairing = transport.getPairingState()
        const items = pairing.status === 'paired' ? await getFilteredQueue() : []
        const payload: GatewayStatus = {
          ok: true,
          mode: transport.mode,
          pairing,
          allowlist: store.getAllowlist(),
          pendingCount: items.length,
          recentAudit: store.getRecentAudit(),
        }
        sendJson(res, 200, payload, corsOrigin)
        return
      }

      if (method === 'GET' && pathname === '/pending') {
        const pairing = transport.getPairingState()
        const items = pairing.status === 'paired' ? await getFilteredQueue() : []
        const payload: PendingResponse = {
          mode: transport.mode,
          paired: pairing.status === 'paired',
          allowlist: store.getAllowlist(),
          items,
          fetchedAt: Date.now(),
        }
        sendJson(res, 200, payload, corsOrigin)
        return
      }

      if (method === 'POST' && pathname === '/press') {
        const body = await readJsonBody<Partial<PressRequest>>(req)
        const bot = normalizeBotHandle(typeof body.bot === 'string' ? body.bot : '')
        const msgId = typeof body.msgId === 'number' ? body.msgId : -1
        const dataB64 = typeof body.dataB64 === 'string' ? body.dataB64 : ''
        const dataBytes = decodeBase64ToBytes(dataB64)

        if (!bot || !Number.isInteger(msgId) || msgId <= 0 || !dataBytes) {
          const err: PressOutcome = {
            ok: false,
            code: 'INVALID_REQUEST',
            message: 'bot, positive integer msgId, and valid callback dataB64 are required',
          }
          sendJson(res, 400, err, corsOrigin)
          return
        }

        if (transport.getPairingState().status !== 'paired') {
          const err: PressOutcome = {
            ok: false,
            code: 'NOT_PAIRED',
            message: 'Pair your account in the companion app first',
          }
          sendJson(res, 409, err, corsOrigin)
          return
        }

        // Gate 1: Strict allowlist check
        const allowlist = store.getAllowlist()
        if (!isAllowlisted(bot, allowlist)) {
          logAudit(bot, msgId, 'unknown', 'refused_allowlist', 'Blocked: bot not on allowlist')
          const err: PressOutcome = {
            ok: false,
            code: 'BOT_NOT_ALLOWLISTED',
            message: `@${bot} is not on the allowlist`,
          }
          sendJson(res, 403, err, corsOrigin)
          return
        }

        // Gate 2: Inspect live inline keyboard button metadata before pressing
        const liveItems = await getFilteredQueue()
        const item = liveItems.find((i) => i.bot === bot && i.msgId === msgId)
        const button = item?.buttons.find((b) => b.dataB64 === dataB64)
        if (!item || !button) {
          const err: PressOutcome = {
            ok: false,
            code: 'BUTTON_NOT_FOUND',
            message: 'Callback button no longer present on that message',
          }
          sendJson(res, 404, err, corsOrigin)
          return
        }

        // Gate 3: Protocol-level refusal for requires_password (2FA)
        if (button.requiresPassword) {
          logAudit(bot, msgId, button.label, 'refused_2fa', '2FA button - open Telegram')
          const err: PressOutcome = {
            ok: false,
            code: 'PASSWORD_REQUIRED',
            message: '2FA button - open Telegram',
          }
          sendJson(res, 403, err, corsOrigin)
          return
        }

        // Gate 4: Protocol-level double-press enforcement for bg_danger
        if (button.danger && body.confirmedDanger !== true) {
          logAudit(
            bot,
            msgId,
            button.label,
            'refused_danger_unconfirmed',
            'Destructive button requires confirmedDanger=true',
          )
          const err: PressOutcome = {
            ok: false,
            code: 'DANGER_CONFIRMATION_REQUIRED',
            message: 'Double-press required for destructive button',
          }
          sendJson(res, 409, err, corsOrigin)
          return
        }

        try {
          const pressed = await transport.pressCallback(bot, msgId, dataBytes)
          const editedLine = pressed.editedRawText
            ? sanitizeAlertLine(pressed.editedRawText)
            : null
          logAudit(
            bot,
            msgId,
            button.label,
            pressed.timedOut ? 'timeout' : 'pressed',
            pressed.timedOut ? 'BOT_RESPONSE_TIMEOUT (logged)' : editedLine || pressed.answer,
          )
          const okRes: PressOutcome = {
            ok: true,
            bot,
            msgId,
            buttonLabel: button.label,
            answer: sanitizeAlertLine(pressed.answer, 48),
            editedLine,
            timedOut: pressed.timedOut,
            pressedAt: Date.now(),
          }
          sendJson(res, 200, okRes, corsOrigin)
          return
        } catch (err) {
          const fail: PressOutcome = {
            ok: false,
            code: 'TRANSPORT_ERROR',
            message: err instanceof Error ? err.message : 'Callback failed',
          }
          sendJson(res, 502, fail, corsOrigin)
          return
        }
      }

      // Allowlist management
      if (method === 'GET' && pathname === '/allowlist') {
        sendJson(res, 200, { ok: true, allowlist: store.getAllowlist() }, corsOrigin)
        return
      }

      if (method === 'POST' && pathname === '/allowlist') {
        const body = await readJsonBody<{ bot?: string }>(req)
        const norm = normalizeBotHandle(body.bot ?? '')
        if (!norm) {
          sendJson(res, 400, { ok: false, message: 'Valid bot username required (3-64 chars, a-z/0-9/_)' }, corsOrigin)
          return
        }
        const allowlist = store.addAllowlist(norm)
        sendJson(res, 200, { ok: true, allowlist }, corsOrigin)
        return
      }

      if (method === 'DELETE' && pathname.startsWith('/allowlist/')) {
        const target = decodeURIComponent(pathname.slice('/allowlist/'.length))
        const allowlist = store.removeAllowlist(target)
        sendJson(res, 200, { ok: true, allowlist }, corsOrigin)
        return
      }

      // Self-hosted pairing endpoints (session stays strictly on user's gateway)
      if (method === 'POST' && pathname === '/pairing/qr') {
        const pairing = await transport.startQrPairing()
        sendJson(res, 200, { ok: true, pairing }, corsOrigin)
        return
      }
      if (method === 'GET' && pathname === '/pairing/qr') {
        const pairing = await transport.pollQrPairing()
        sendJson(res, 200, { ok: true, pairing }, corsOrigin)
        return
      }
      if (method === 'POST' && pathname === '/pairing/phone') {
        const body = await readJsonBody<{ phoneNumber?: string }>(req)
        const pairing = await transport.startPhonePairing(body.phoneNumber ?? '')
        sendJson(res, 200, { ok: true, pairing }, corsOrigin)
        return
      }
      if (method === 'POST' && pathname === '/pairing/code') {
        const body = await readJsonBody<{ code?: string }>(req)
        const pairing = await transport.submitPhoneCode(body.code ?? '')
        sendJson(res, 200, { ok: true, pairing }, corsOrigin)
        return
      }
      if (method === 'POST' && pathname === '/pairing/2fa') {
        const body = await readJsonBody<{ password?: string }>(req)
        const pairing = await transport.submit2FAPassword(body.password ?? '')
        sendJson(res, 200, { ok: true, pairing }, corsOrigin)
        return
      }
      if (method === 'POST' && pathname === '/pairing/disconnect') {
        const pairing = await transport.disconnect()
        sendJson(res, 200, { ok: true, pairing }, corsOrigin)
        return
      }

      if (method === 'POST' && pathname === '/demo/reset' && transport.mode === 'demo' && transport.resetDemo) {
        transport.resetDemo()
        sendJson(res, 200, { ok: true, mode: 'demo' }, corsOrigin)
        return
      }

      // Explicitly no chat-reading, dialog-listing, or send-message endpoints exist
      sendJson(res, 404, { ok: false, message: 'Not found' }, corsOrigin)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal error'
      const status = msg === 'INVALID_JSON' ? 400 : msg === 'BODY_TOO_LARGE' ? 413 : 500
      sendJson(res, status, { ok: false, message: msg }, corsOrigin)
    }
  })
}
