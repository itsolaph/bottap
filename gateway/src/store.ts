import fs from 'node:fs'
import path from 'node:path'
import {
  normalizeAllowlist,
  normalizeChatPeer,
  normalizeGroupAllowlist,
  type AuditEntry,
} from '@bottap/shared'

export interface PersistedState {
  allowlist: string[]
  groups: string[]
  recentAudit: AuditEntry[]
  pressedTombstones: Record<string, number>
}

const MAX_AUDIT_ENTRIES = 50
const TOMBSTONE_TTL_MS = 30 * 60 * 1000

function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmpPath, 'w', mode)
  try {
    fs.writeSync(fd, content, 0, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, mode)
  } catch {
    // Windows chmod is partial; safe to ignore on non-POSIX hosts
  }
}

export class GatewayStore {
  readonly dataDir: string
  private readonly statePath: string
  private readonly sessionPath: string
  private state: PersistedState

  constructor(
    dataDir: string,
    initialAllowlist: readonly string[] = [],
    initialGroups: readonly string[] = [],
  ) {
    this.dataDir = path.resolve(dataDir)
    this.statePath = path.join(this.dataDir, 'state.json')
    this.sessionPath = path.join(this.dataDir, 'session.txt')
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    this.state = this.loadState(initialAllowlist, initialGroups)
  }

  private pruneTombstones(
    raw: Record<string, number> | undefined,
    now = Date.now(),
  ): Record<string, number> {
    const out: Record<string, number> = {}
    if (!raw || typeof raw !== 'object') return out
    for (const [k, exp] of Object.entries(raw)) {
      if (typeof exp === 'number' && exp > now) {
        out[k] = exp
      }
    }
    return out
  }

  private loadState(
    fallbackAllowlist: readonly string[],
    fallbackGroups: readonly string[],
  ): PersistedState {
    if (fs.existsSync(this.statePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<PersistedState>
        const existingAllow = normalizeAllowlist(Array.isArray(parsed.allowlist) ? parsed.allowlist : [])
        const existingGroups = normalizeGroupAllowlist(Array.isArray(parsed.groups) ? parsed.groups : [])
        const mergedAllow =
          existingAllow.length > 0 ? existingAllow : normalizeAllowlist(fallbackAllowlist)
        const mergedGroups =
          existingGroups.length > 0 ? existingGroups : normalizeGroupAllowlist(fallbackGroups)
        return {
          allowlist: mergedAllow,
          groups: mergedGroups,
          recentAudit: Array.isArray(parsed.recentAudit)
            ? parsed.recentAudit.slice(0, MAX_AUDIT_ENTRIES)
            : [],
          pressedTombstones: this.pruneTombstones(parsed.pressedTombstones),
        }
      } catch {
        // Fall through to clean initial state if state file was corrupted
      }
    }
    const fresh: PersistedState = {
      allowlist: normalizeAllowlist(fallbackAllowlist),
      groups: normalizeGroupAllowlist(fallbackGroups),
      recentAudit: [],
      pressedTombstones: {},
    }
    this.saveState(fresh)
    return fresh
  }

  private saveState(next: PersistedState): void {
    this.state = next
    atomicWriteFile(this.statePath, JSON.stringify(next, null, 2) + '\n', 0o600)
  }

  getAllowlist(): string[] {
    return [...this.state.allowlist]
  }

  setAllowlist(handles: readonly string[]): string[] {
    const normalized = normalizeAllowlist(handles)
    this.saveState({ ...this.state, allowlist: normalized })
    return [...normalized]
  }

  addAllowlist(handle: string): string[] {
    return this.setAllowlist([...this.state.allowlist, handle])
  }

  removeAllowlist(handle: string): string[] {
    const target = handle.trim().replace(/^@+/, '').toLowerCase()
    return this.setAllowlist(this.state.allowlist.filter((h) => h !== target))
  }

  getGroups(): string[] {
    return [...this.state.groups]
  }

  setGroups(peers: readonly string[]): string[] {
    const normalized = normalizeGroupAllowlist(peers)
    this.saveState({ ...this.state, groups: normalized })
    return [...normalized]
  }

  addGroup(peer: string): string[] {
    return this.setGroups([...this.state.groups, peer])
  }

  removeGroup(peer: string): string[] {
    const target = normalizeChatPeer(peer)
    return this.setGroups(this.state.groups.filter((g) => g !== target))
  }

  markPressed(chatPeer: string, msgId: number, ttlMs = TOMBSTONE_TTL_MS): void {
    const now = Date.now()
    const pruned = this.pruneTombstones(this.state.pressedTombstones, now)
    pruned[`${chatPeer}:${msgId}`] = now + ttlMs
    this.saveState({ ...this.state, pressedTombstones: pruned })
  }

  isRecentlyPressed(chatPeer: string, msgId: number, now = Date.now()): boolean {
    const exp = this.state.pressedTombstones[`${chatPeer}:${msgId}`]
    return typeof exp === 'number' && exp > now
  }

  clearTombstones(): void {
    this.saveState({ ...this.state, pressedTombstones: {} })
  }

  getRecentAudit(): AuditEntry[] {
    return [...this.state.recentAudit]
  }

  appendAudit(entry: AuditEntry): void {
    const nextAudit = [entry, ...this.state.recentAudit].slice(0, MAX_AUDIT_ENTRIES)
    this.saveState({ ...this.state, recentAudit: nextAudit })
  }

  loadSessionString(): string {
    if (!fs.existsSync(this.sessionPath)) return ''
    try {
      return fs.readFileSync(this.sessionPath, 'utf8').trim()
    } catch {
      return ''
    }
  }

  saveSessionString(session: string): void {
    atomicWriteFile(this.sessionPath, session.trim(), 0o600)
  }

  clearSessionString(): void {
    if (fs.existsSync(this.sessionPath)) {
      fs.unlinkSync(this.sessionPath)
    }
  }
}
