import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import {
  buildQueueItem,
  decodeBase64ToBytes,
  isAllowlisted,
  isGroupAllowlisted,
  normalizeBotHandle,
  normalizeChatPeer,
  sanitizeAlertLine,
  type ArmRequest,
  type ArmResponse,
  type AuditOutcome,
  type GatewayStatus,
  type PendingResponse,
  type PressOutcome,
  type PressRequest,
  type QueueItem,
  type ScanDiagnostic,
} from '@bottap/shared'
import type { GatewayStore } from './store.js'
import type { BotTransport } from './transport.js'

const MAX_BODY_BYTES = 16 * 1024
const ARM_TTL_MS = 8_000
const RATE_WINDOW_MS = 60_000

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

interface ArmRecord {
  readonly key: string
  readonly expiresAt: number
}

class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()

  allow(bucketKey: string, limit: number, now = Date.now()): boolean {
    const existing = this.buckets.get(bucketKey)
    if (!existing || now >= existing.resetAt) {
      if (this.buckets.size > 512) {
        for (const [k, v] of this.buckets) {
          if (now >= v.resetAt) this.buckets.delete(k)
        }
      }
      this.buckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS })
      return true
    }
    if (existing.count >= limit) return false
    existing.count += 1
    return true
  }
}

function parseAllowedOrigins(raw?: string): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  for (const part of raw.split(',')) {
    const trimmed = part.trim().replace(/\/+$/, '')
    if (trimmed && trimmed !== '*') {
      out.add(trimmed)
    }
  }
  return out
}

function isLoopbackHostHeader(hostHeader?: string): boolean {
  if (!hostHeader) return false
  const raw = hostHeader.trim().toLowerCase()
  if (raw.startsWith('[::1]')) {
    const rest = raw.slice(5)
    return rest === '' || /^:\d+$/.test(rest)
  }
  const hostname = raw.split(':')[0] ?? ''
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

function hasProxyHeaders(req: IncomingMessage): boolean {
  return Boolean(
    req.headers['x-forwarded-for'] ||
      req.headers['x-forwarded-host'] ||
      req.headers.forwarded ||
      req.headers['cf-connecting-ip'],
  )
}

function isSameOrigin(origin: string, hostHeader?: string): boolean {
  if (!hostHeader) return false
  const cleanOrigin = origin.trim().replace(/\/+$/, '')
  return cleanOrigin === `http://${hostHeader}` || cleanOrigin === `https://${hostHeader}`
}

function resolveCorsHeader(
  req: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): { allowed: boolean; headerValue: string | null } {
  const origin = req.headers.origin
  if (!origin) return { allowed: true, headerValue: null }
  const cleanOrigin = origin.trim().replace(/\/+$/, '')
  if (isSameOrigin(cleanOrigin, req.headers.host)) {
    return { allowed: true, headerValue: cleanOrigin }
  }
  if (allowedOrigins.has(cleanOrigin)) {
    return { allowed: true, headerValue: cleanOrigin }
  }
  return { allowed: false, headerValue: null }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  corsHeader: string | null,
): void {
  const payload = JSON.stringify(body)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }
  if (corsHeader) {
    headers['Access-Control-Allow-Origin'] = corsHeader
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
  }
  res.writeHead(status, headers)
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
  if (
    !candidate.startsWith(resolvedRoot + path.sep) &&
    candidate !== path.join(resolvedRoot, 'index.html')
  ) {
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

function clientIpOf(req: IncomingMessage): string {
  return req.socket.remoteAddress || 'local'
}

export function createGatewayServer(options: GatewayServerOptions): http.Server {
  const allowedOrigins = parseAllowedOrigins(options.corsOrigin)
  const { transport, store } = options
  const limiter = new FixedWindowLimiter()
  const armedTokens = new Map<string, ArmRecord>()

  const pruneArmed = (now = Date.now()) => {
    for (const [tok, rec] of armedTokens) {
      if (now >= rec.expiresAt) armedTokens.delete(tok)
    }
  }

  const armKey = (chatPeer: string, bot: string, msgId: number, dataB64: string, line: string) =>
    `${chatPeer}:${bot}:${msgId}:${dataB64}:${line}`

  const issueArmToken = (
    chatPeer: string,
    bot: string,
    msgId: number,
    dataB64: string,
    line: string,
  ): ArmResponse => {
    const now = Date.now()
    pruneArmed(now)
    const armToken = crypto.randomBytes(16).toString('base64url')
    const expiresAt = now + ARM_TTL_MS
    armedTokens.set(armToken, { key: armKey(chatPeer, bot, msgId, dataB64, line), expiresAt })
    return { ok: true, armToken, expiresAt }
  }

  const consumeArmToken = (
    token: string | undefined,
    chatPeer: string,
    bot: string,
    msgId: number,
    dataB64: string,
    line: string,
  ): boolean => {
    const now = Date.now()
    pruneArmed(now)
    if (!token) return false
    const rec = armedTokens.get(token)
    if (!rec) return false
    const expected = armKey(chatPeer, bot, msgId, dataB64, line)
    if (now >= rec.expiresAt || rec.key !== expected) {
      return false
    }
    armedTokens.delete(token)
    return true
  }

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

  const getFilteredQueue = async (): Promise<{
    items: QueueItem[]
    diagnostics: ScanDiagnostic[]
  }> => {
    const allowlist = store.getAllowlist()
    const groups = store.getGroups()
    const scan = await transport.scanPending(allowlist, groups)
    const items: QueueItem[] = []
    for (const raw of scan.items) {
      const built = buildQueueItem(raw, allowlist)
      if (!built) continue
      if (store.isRecentlyPressed(built.chatPeer, built.msgId)) continue
      items.push(built)
    }
    return { items, diagnostics: scan.diagnostics }
  }

  return http.createServer(async (req, res) => {
    const cors = resolveCorsHeader(req, allowedOrigins)
    try {
      const method = req.method ?? 'GET'
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = parsed.pathname

      if (method === 'OPTIONS') {
        if (!cors.allowed) {
          sendJson(res, 403, { ok: false, message: 'Origin not allowed' }, null)
          return
        }
        const headers: Record<string, string> = { Vary: 'Origin' }
        if (cors.headerValue) {
          headers['Access-Control-Allow-Origin'] = cors.headerValue
          headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
          headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        }
        res.writeHead(204, headers)
        res.end()
        return
      }

      if (method === 'GET' && pathname === '/health') {
        const proxyDenied =
          !options.authToken && (hasProxyHeaders(req) || !isLoopbackHostHeader(req.headers.host))
        sendJson(
          res,
          proxyDenied ? 403 : 200,
          proxyDenied
            ? {
                ok: false,
                code: 'TOKEN_REQUIRED_FOR_PROXY',
                message: 'Set BOTTAP_TOKEN before accessing via proxy',
              }
            : {
                ok: true,
                mode: transport.mode,
                tokenRequired: Boolean(options.authToken),
              },
          proxyDenied ? null : cors.headerValue,
        )
        return
      }

      // Static companion UI assets (no auth required for HTML/JS/CSS shell)
      if (
        method === 'GET' &&
        options.staticDir &&
        !pathname.startsWith('/pending') &&
        !pathname.startsWith('/status') &&
        !pathname.startsWith('/allowlist') &&
        !pathname.startsWith('/groups') &&
        !pathname.startsWith('/pairing') &&
        !pathname.startsWith('/arm')
      ) {
        if (tryServeStatic(options.staticDir, pathname, res)) {
          return
        }
      }

      // Fail closed against DNS rebinding and reverse-proxy exposure when running tokenless on loopback
      if (!options.authToken && (hasProxyHeaders(req) || !isLoopbackHostHeader(req.headers.host))) {
        sendJson(
          res,
          403,
          {
            ok: false,
            code: 'TOKEN_REQUIRED_FOR_PROXY',
            message: 'Set BOTTAP_TOKEN before accessing the gateway through a non-loopback host or proxy',
          },
          null,
        )
        return
      }

      // Block cross-origin requests from untrusted origins on all API routes
      if (!cors.allowed) {
        sendJson(
          res,
          403,
          { ok: false, code: 'ORIGIN_NOT_ALLOWED', message: 'Cross-origin request blocked' },
          null,
        )
        return
      }

      if (!verifyBearer(req, options.authToken)) {
        sendJson(
          res,
          401,
          { ok: false, code: 'UNAUTHORIZED', message: 'Valid Bearer token required' },
          cors.headerValue,
        )
        return
      }

      const ip = clientIpOf(req)

      if (method === 'GET' && pathname === '/status') {
        if (!limiter.allow(`read:${ip}`, 90)) {
          sendJson(
            res,
            429,
            { ok: false, code: 'RATE_LIMITED', message: 'Too many requests, retry shortly' },
            cors.headerValue,
          )
          return
        }
        const rawPairing = transport.getPairingState()
        const { qrUrl: _redactedQr, ...safePairing } = rawPairing
        const queue =
          rawPairing.status === 'paired' ? await getFilteredQueue() : { items: [], diagnostics: [] }
        const payload: GatewayStatus = {
          ok: true,
          mode: transport.mode,
          pairing: safePairing,
          allowlist: store.getAllowlist(),
          groups: store.getGroups(),
          pendingCount: queue.items.length,
          scanDiagnostics: queue.diagnostics,
          recentAudit: store.getRecentAudit(),
        }
        sendJson(res, 200, payload, cors.headerValue)
        return
      }

      if (method === 'GET' && pathname === '/pending') {
        if (!limiter.allow(`read:${ip}`, 90)) {
          sendJson(
            res,
            429,
            { ok: false, code: 'RATE_LIMITED', message: 'Too many requests, retry shortly' },
            cors.headerValue,
          )
          return
        }
        const pairing = transport.getPairingState()
        const queue =
          pairing.status === 'paired' ? await getFilteredQueue() : { items: [], diagnostics: [] }
        const payload: PendingResponse = {
          mode: transport.mode,
          paired: pairing.status === 'paired',
          allowlist: store.getAllowlist(),
          groups: store.getGroups(),
          items: queue.items,
          scanDiagnostics: queue.diagnostics,
          fetchedAt: Date.now(),
        }
        sendJson(res, 200, payload, cors.headerValue)
        return
      }

      // Server-issued single-use arm token bound to exact live (chatPeer, bot, msgId, dataB64, line)
      if (method === 'POST' && pathname === '/arm') {
        if (!limiter.allow(`arm:${ip}`, 40)) {
          sendJson(
            res,
            429,
            { ok: false, code: 'RATE_LIMITED', message: 'Too many requests, retry shortly' },
            cors.headerValue,
          )
          return
        }
        const body = await readJsonBody<Partial<ArmRequest>>(req)
        const bot = normalizeBotHandle(typeof body.bot === 'string' ? body.bot : '')
        const chatPeer = normalizeChatPeer(typeof body.chatPeer === 'string' ? body.chatPeer : '') ?? bot
        const msgId = typeof body.msgId === 'number' ? body.msgId : -1
        const dataB64 = typeof body.dataB64 === 'string' ? body.dataB64 : ''
        const dataBytes = decodeBase64ToBytes(dataB64)
        if (!bot || !chatPeer || !Number.isInteger(msgId) || msgId <= 0 || !dataBytes) {
          sendJson(
            res,
            400,
            { ok: false, code: 'INVALID_REQUEST', message: 'Valid bot, msgId, and dataB64 required' },
            cors.headerValue,
          )
          return
        }
        if (transport.getPairingState().status !== 'paired') {
          sendJson(
            res,
            409,
            { ok: false, code: 'NOT_PAIRED', message: 'Pair your account in the companion app first' },
            cors.headerValue,
          )
          return
        }
        const allowlist = store.getAllowlist()
        const groups = store.getGroups()
        if (!isAllowlisted(bot, allowlist) || (chatPeer !== bot && !isGroupAllowlisted(chatPeer, groups))) {
          sendJson(
            res,
            403,
            { ok: false, code: 'BOT_NOT_ALLOWLISTED', message: `@${bot} is not on the allowlist` },
            cors.headerValue,
          )
          return
        }
        const rawMsg = await transport.fetchMessage(chatPeer, bot, msgId)
        const item = rawMsg ? buildQueueItem(rawMsg, allowlist) : null
        const matches = item?.buttons.filter((b) => b.dataB64 === dataB64) ?? []
        const button = matches.length === 1 ? matches[0] : undefined
        if (!item || !button) {
          sendJson(
            res,
            404,
            { ok: false, code: 'BUTTON_NOT_FOUND', message: 'Callback button no longer present' },
            cors.headerValue,
          )
          return
        }
        if (button.requiresPassword) {
          sendJson(
            res,
            403,
            { ok: false, code: 'PASSWORD_REQUIRED', message: '2FA button - open Telegram' },
            cors.headerValue,
          )
          return
        }
        if (!button.danger) {
          sendJson(
            res,
            400,
            { ok: false, code: 'INVALID_REQUEST', message: 'Arm token only applies to danger buttons' },
            cors.headerValue,
          )
          return
        }
        logAudit(bot, msgId, button.label, 'arm_issued', `Armed (${button.dangerSource ?? 'policy'})`)
        sendJson(res, 200, issueArmToken(chatPeer, bot, msgId, dataB64, item.line), cors.headerValue)
        return
      }

      if (method === 'POST' && pathname === '/press') {
        if (!limiter.allow(`press:${ip}`, 40)) {
          const err: PressOutcome = {
            ok: false,
            code: 'RATE_LIMITED',
            message: 'Too many requests, retry shortly',
          }
          sendJson(res, 429, err, cors.headerValue)
          return
        }

        const body = await readJsonBody<Partial<PressRequest>>(req)
        const bot = normalizeBotHandle(typeof body.bot === 'string' ? body.bot : '')
        const chatPeer = normalizeChatPeer(typeof body.chatPeer === 'string' ? body.chatPeer : '') ?? bot
        const msgId = typeof body.msgId === 'number' ? body.msgId : -1
        const dataB64 = typeof body.dataB64 === 'string' ? body.dataB64 : ''
        const dataBytes = decodeBase64ToBytes(dataB64)

        if (!bot || !chatPeer || !Number.isInteger(msgId) || msgId <= 0 || !dataBytes) {
          const err: PressOutcome = {
            ok: false,
            code: 'INVALID_REQUEST',
            message: 'bot, positive integer msgId, and valid callback dataB64 are required',
          }
          sendJson(res, 400, err, cors.headerValue)
          return
        }

        if (transport.getPairingState().status !== 'paired') {
          const err: PressOutcome = {
            ok: false,
            code: 'NOT_PAIRED',
            message: 'Pair your account in the companion app first',
          }
          sendJson(res, 409, err, cors.headerValue)
          return
        }

        // Gate 1: Strict allowlist check (bot + optional group)
        const allowlist = store.getAllowlist()
        const groups = store.getGroups()
        if (!isAllowlisted(bot, allowlist) || (chatPeer !== bot && !isGroupAllowlisted(chatPeer, groups))) {
          logAudit(bot, msgId, 'unknown', 'refused_allowlist', 'Blocked: bot/group not on allowlist')
          const err: PressOutcome = {
            ok: false,
            code: 'BOT_NOT_ALLOWLISTED',
            message: `@${bot} is not on the allowlist`,
          }
          sendJson(res, 403, err, cors.headerValue)
          return
        }

        // Gate 2: Targeted live fetch of the exact target message (never stale cache)
        const rawMsg = await transport.fetchMessage(chatPeer, bot, msgId)
        const item = rawMsg ? buildQueueItem(rawMsg, store.getAllowlist()) : null
        const matches = item?.buttons.filter((b) => b.dataB64 === dataB64) ?? []
        const button = matches.length === 1 ? matches[0] : undefined
        if (!rawMsg || !item || !button) {
          const err: PressOutcome = {
            ok: false,
            code: 'BUTTON_NOT_FOUND',
            message: 'Callback button no longer present on that message',
          }
          sendJson(res, 404, err, cors.headerValue)
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
          sendJson(res, 403, err, cors.headerValue)
          return
        }

        // Gate 4: Server-enforced two-step confirmation bound to exact live message text
        if (button.danger) {
          const hasValidArm =
            body.confirmedDanger === true &&
            consumeArmToken(
              typeof body.armToken === 'string' ? body.armToken : undefined,
              chatPeer,
              bot,
              msgId,
              dataB64,
              item.line,
            )
          if (!hasValidArm) {
            logAudit(
              bot,
              msgId,
              button.label,
              'refused_danger_unconfirmed',
              'Destructive button requires server-issued two-step arm token',
            )
            const err: PressOutcome = {
              ok: false,
              code: 'DANGER_CONFIRMATION_REQUIRED',
              message: 'Double-press arm token required for destructive button',
            }
            sendJson(res, 409, err, cors.headerValue)
            return
          }
        }

        try {
          const pressed = await transport.pressCallback(
            chatPeer,
            bot,
            msgId,
            dataBytes,
            rawMsg.rawText,
          )
          const editedLine = pressed.editedRawText
            ? sanitizeAlertLine(pressed.editedRawText)
            : null
          store.markPressed(chatPeer, msgId)
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
            chatPeer,
            msgId,
            buttonLabel: button.label,
            answer: sanitizeAlertLine(pressed.answer, 48),
            editedLine,
            timedOut: pressed.timedOut,
            pressedAt: Date.now(),
          }
          sendJson(res, 200, okRes, cors.headerValue)
          return
        } catch (err) {
          const rawErr = err instanceof Error ? err.message : String(err)
          if (rawErr === 'BUTTON_NOT_FOUND') {
            const fail: PressOutcome = {
              ok: false,
              code: 'BUTTON_NOT_FOUND',
              message: 'Alert expired or button removed',
            }
            sendJson(res, 404, fail, cors.headerValue)
            return
          }
          if (rawErr.startsWith('RATE_LIMITED:')) {
            const secs = rawErr.split(':')[1] || '30'
            const fail: PressOutcome = {
              ok: false,
              code: 'RATE_LIMITED',
              message: `Telegram flood wait — retry in ${secs}s`,
            }
            sendJson(res, 429, fail, cors.headerValue)
            return
          }
          console.error('[bottap-gateway] pressCallback failed:', rawErr)
          const fail: PressOutcome = {
            ok: false,
            code: 'TRANSPORT_ERROR',
            message: 'Gateway transport error',
          }
          sendJson(res, 502, fail, cors.headerValue)
          return
        }
      }

      // Allowlist management (audited)
      if (method === 'GET' && pathname === '/allowlist') {
        sendJson(res, 200, { ok: true, allowlist: store.getAllowlist() }, cors.headerValue)
        return
      }

      if (method === 'POST' && pathname === '/allowlist') {
        const body = await readJsonBody<{ bot?: string }>(req)
        const norm = normalizeBotHandle(body.bot ?? '')
        if (!norm) {
          sendJson(
            res,
            400,
            { ok: false, message: 'Valid bot username required (3-64 chars, a-z/0-9/_)' },
            cors.headerValue,
          )
          return
        }
        const allowlist = store.addAllowlist(norm)
        logAudit(norm, 0, 'allowlist', 'allowlist_add', `Added @${norm}`)
        sendJson(res, 200, { ok: true, allowlist }, cors.headerValue)
        return
      }

      if (method === 'DELETE' && pathname.startsWith('/allowlist/')) {
        const target = decodeURIComponent(pathname.slice('/allowlist/'.length))
        const norm = normalizeBotHandle(target) ?? target
        const allowlist = store.removeAllowlist(target)
        logAudit(norm, 0, 'allowlist', 'allowlist_remove', `Removed @${norm}`)
        sendJson(res, 200, { ok: true, allowlist }, cors.headerValue)
        return
      }

      // Ops group allowlist management (audited)
      if (method === 'GET' && pathname === '/groups') {
        sendJson(res, 200, { ok: true, groups: store.getGroups() }, cors.headerValue)
        return
      }

      if (method === 'POST' && pathname === '/groups') {
        const body = await readJsonBody<{ group?: string }>(req)
        const norm = normalizeChatPeer(body.group ?? '')
        if (!norm) {
          sendJson(
            res,
            400,
            { ok: false, message: 'Valid group username or numeric chat ID required' },
            cors.headerValue,
          )
          return
        }
        const groups = store.addGroup(norm)
        logAudit(norm, 0, 'groups', 'allowlist_add', `Added group ${norm}`)
        sendJson(res, 200, { ok: true, groups }, cors.headerValue)
        return
      }

      if (method === 'DELETE' && pathname.startsWith('/groups/')) {
        const target = decodeURIComponent(pathname.slice('/groups/'.length))
        const groups = store.removeGroup(target)
        logAudit(target, 0, 'groups', 'allowlist_remove', `Removed group ${target}`)
        sendJson(res, 200, { ok: true, groups }, cors.headerValue)
        return
      }

      // Self-hosted pairing endpoints (separate poll bucket from sensitive write bucket)
      if (method === 'GET' && pathname === '/pairing/qr') {
        if (!limiter.allow(`qr-poll:${ip}`, 45)) {
          sendJson(
            res,
            429,
            { ok: false, code: 'RATE_LIMITED', message: 'QR poll rate limit reached, retry shortly' },
            cors.headerValue,
          )
          return
        }
        const pairing = await transport.pollQrPairing()
        sendJson(res, 200, { ok: true, pairing }, cors.headerValue)
        return
      }

      if (pathname.startsWith('/pairing/')) {
        if (!limiter.allow(`pairing:${ip}`, 12)) {
          sendJson(
            res,
            429,
            { ok: false, code: 'RATE_LIMITED', message: 'Pairing rate limit reached, retry shortly' },
            cors.headerValue,
          )
          return
        }
      }

      if (method === 'POST' && pathname === '/pairing/qr') {
        const pairing = await transport.startQrPairing()
        sendJson(res, 200, { ok: true, pairing }, cors.headerValue)
        return
      }
      if (method === 'POST' && pathname === '/pairing/phone') {
        const body = await readJsonBody<{ phoneNumber?: string }>(req)
        const pairing = await transport.startPhonePairing(body.phoneNumber ?? '')
        sendJson(res, 200, { ok: true, pairing }, cors.headerValue)
        return
      }
      if (method === 'POST' && pathname === '/pairing/code') {
        const body = await readJsonBody<{ code?: string }>(req)
        const pairing = await transport.submitPhoneCode(body.code ?? '')
        sendJson(res, 200, { ok: true, pairing }, cors.headerValue)
        return
      }
      if (method === 'POST' && pathname === '/pairing/2fa') {
        const body = await readJsonBody<{ password?: string }>(req)
        const pairing = await transport.submit2FAPassword(body.password ?? '')
        sendJson(res, 200, { ok: true, pairing }, cors.headerValue)
        return
      }
      if (method === 'POST' && pathname === '/pairing/disconnect') {
        const pairing = await transport.disconnect()
        armedTokens.clear()
        store.clearTombstones()
        sendJson(res, 200, { ok: true, pairing }, cors.headerValue)
        return
      }

      if (
        method === 'POST' &&
        pathname === '/demo/reset' &&
        transport.mode === 'demo' &&
        transport.resetDemo
      ) {
        transport.resetDemo()
        armedTokens.clear()
        store.clearTombstones()
        sendJson(res, 200, { ok: true, mode: 'demo' }, cors.headerValue)
        return
      }

      // Explicitly no chat-reading, dialog-listing, or send-message endpoints exist
      sendJson(res, 404, { ok: false, message: 'Not found' }, cors.headerValue)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal error'
      const isClientErr =
        msg === 'INVALID_JSON' ||
        msg === 'BODY_TOO_LARGE' ||
        msg === 'Phone number is required' ||
        msg === 'Start phone pairing first' ||
        msg === '2FA verification is not active' ||
        msg === 'Invalid login code' ||
        msg === 'Invalid 2FA password' ||
        msg.startsWith('Too many failed') ||
        msg.startsWith('Set TG_API_ID')
      const status =
        msg === 'BODY_TOO_LARGE'
          ? 413
          : msg.startsWith('Too many failed')
            ? 429
            : isClientErr
              ? 400
              : 500
      if (!isClientErr) {
        console.error('[bottap-gateway] internal error:', msg)
      }
      sendJson(
        res,
        status,
        { ok: false, message: isClientErr ? msg : 'Gateway request failed' },
        cors.headerValue,
      )
    }
  })
}
