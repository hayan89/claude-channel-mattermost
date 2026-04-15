/**
 * Shared types, constants, and utilities for the Mattermost channel plugin.
 * Used by both server.ts (MCP server) and router.ts (coordinator daemon).
 *
 * This module contains NO mutable process-local state.
 * (crontab utilities manipulate external system state, not process-local.)
 */

import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, appendFileSync,
  renameSync, realpathSync, chmodSync, unlinkSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'

// ── State paths ────────────────────────────────────────────────────────────

export const STATE_DIR = process.env.MATTERMOST_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'mattermost')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const MEMORY_DIR = join(STATE_DIR, 'memory')
export const MODES_DIR = join(STATE_DIR, 'modes')
export const SCHEDULES_DIR = join(STATE_DIR, 'schedules')

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_CHUNK_LIMIT = 16383
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_SCHEDULES_PER_CHANNEL = 20
export const SCHEDULED_RE = /^\[scheduled:(sch_[a-f0-9]+)\]\s*/

// ── .env loader ────────────────────────────────────────────────────────────

export function loadEnvFile(): void {
  try {
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// ── Logger ────────────────────────────────────────────────────────────────

type LogLevel = 'DEBUG' | 'INFO' | 'ERROR'

const LEVEL_NUM: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, ERROR: 2 }
const LEVEL_PAD: Record<LogLevel, string> = { DEBUG: 'DEBUG', INFO: 'INFO ', ERROR: 'ERROR' }

export type Logger = {
  debug(msg: string): void
  info(msg: string): void
  error(msg: string): void
  child(subPrefix: string): Logger
}

export type LoggerOptions = {
  /** Also write to a file (e.g. trigger.ts log) */
  filePath?: string
  /** Max file size in bytes before truncation (default: 1_000_000) */
  maxFileBytes?: number
  /** Lines to keep when truncating (default: 500) */
  keepLines?: number
}

function writeToFile(line: string, opts: LoggerOptions): void {
  const { filePath, maxFileBytes = 1_000_000, keepLines = 500 } = opts
  if (!filePath) return
  appendFileSync(filePath, line)
  try {
    if (statSync(filePath).size > maxFileBytes) {
      const content = readFileSync(filePath, 'utf8')
      const lines = content.split('\n').slice(-keepLines)
      writeFileSync(filePath, lines.join('\n') + '\n')
    }
  } catch {}
}

export function createLogger(prefix: string, opts?: LoggerOptions): Logger {
  function emit(level: LogLevel, msg: string): void {
    const cur = LEVEL_NUM[(process.env.LOG_LEVEL as LogLevel)] ?? LEVEL_NUM.INFO
    if (LEVEL_NUM[level] < cur) return
    const line = `${new Date().toISOString()} ${LEVEL_PAD[level]} [${prefix}] ${msg}\n`
    process.stderr.write(line)
    if (opts?.filePath) writeToFile(line, opts)
  }
  return {
    debug(msg: string) { emit('DEBUG', msg) },
    info(msg: string) { emit('INFO', msg) },
    error(msg: string) { emit('ERROR', msg) },
    child(subPrefix: string) { return createLogger(`${prefix}.${subPrefix}`, opts) },
  }
}

const sharedLog = createLogger('shared')

// ── Types ──────────────────────────────────────────────────────────────────

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /**
   * Forward Mattermost incoming webhooks to Claude. Off by default.
   * `allowedSources` is an `override_username` allowlist:
   *   - `["grafana", "github"]` — only these sender names pass
   *   - `["*"]` — wildcard, any non-empty `override_username` passes (high risk;
   *     equivalent to letting any webhook-token holder trigger Claude)
   *   - `[]` — opt-in flag set but every source blocked (safe default for new channels)
   * `override_username` must be a non-empty string in all cases — anonymous
   * webhooks (no `override_username`) are always dropped.
   */
  forwardWebhooks?: { allowedSources: string[] }
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID, not team ID. One entry per Mattermost channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  /** Emoji short name to react with on receipt. e.g. "eyes". Empty string disables. */
  ackReaction?: string
  /** Which chunks get threading when reply_to/thread_id is passed. Default: 'first'. 'off' = no threading. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 16383 (Mattermost default max). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
  /** Keep typing indicator alive while Claude is processing. Default: true. */
  typingHeartbeat?: boolean
  /** Enable progress status messages via update_status tool. Default: true. */
  progressStatus?: boolean
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export type NoteEntry = { content: string; ts: string }
export type NotesFile = { notes: Record<string, NoteEntry> }

export type ChatMode = { mode: 'plan'; since: string }

export type ScheduleEntry = {
  id: string
  cron: string
  prompt: string
  description?: string
  createdBy: string
  createdAt: string
}

export type InboxMessage = {
  postId: string
  channelId: string
  userId: string
  userName: string
  message: string
  rootId?: string
  fileIds?: string[]
  createAt: number
  channelType: string
  attachments?: Array<{ name: string; mimeType: string; sizeKB: string }>
  modeCommand?: 'plan' | 'go' | 'cancel'
  modeExtra?: string
  scheduledId?: string
  /** True if this message originated from a Mattermost incoming webhook. */
  isWebhook?: boolean
  /**
   * Sender-asserted source identifier (`post.props.override_username`).
   * NOT authenticated — any webhook-token holder can set this to any string.
   * Use only as context hint, never as authorization signal.
   */
  webhookSource?: string
}

// ── Mattermost REST client ─────────────────────────────────────────────────

export type MmClient = {
  url: string
  token: string
  botUserId: string
  botUsername: string
  api(method: string, path: string, body?: unknown): Promise<any>
  get(p: string): Promise<any>
  post(p: string, b: unknown): Promise<any>
  put(p: string, b: unknown): Promise<any>
  del(p: string): Promise<any>
}

export function createMmClient(url: string, token: string): MmClient {
  const client: MmClient = {
    url,
    token,
    botUserId: '',
    botUsername: '',

    async api(method: string, path: string, body?: unknown): Promise<any> {
      const delays = [500, 1500, 4500]  // 3 retries on transient errors
      let lastErr: unknown
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const res = await fetch(`${client.url}/api/v4${path}`, {
            method,
            headers: {
              'Authorization': `Bearer ${client.token}`,
              'Content-Type': 'application/json',
            },
            ...(body != null ? { body: JSON.stringify(body) } : {}),
          })
          if (!res.ok) {
            const detail = await res.text().catch(() => '')
            const err = new Error(`MM API ${method} ${path}: ${res.status} ${detail}`)
            if (res.status >= 500 && res.status < 600 && attempt < delays.length) {
              sharedLog.debug(`MM ${method} ${path} ${res.status}, retrying in ${delays[attempt]}ms`)
              lastErr = err
              await new Promise(r => setTimeout(r, delays[attempt]))
              continue
            }
            throw err
          }
          const text = await res.text()
          return text ? JSON.parse(text) : undefined
        } catch (err) {
          // Network-level fetch failure → retry
          if (err instanceof Error && err.message.startsWith('MM API ')) throw err
          if (attempt < delays.length) {
            sharedLog.debug(`MM ${method} ${path} network error, retrying in ${delays[attempt]}ms: ${err}`)
            lastErr = err
            await new Promise(r => setTimeout(r, delays[attempt]))
            continue
          }
          throw err
        }
      }
      throw lastErr ?? new Error(`MM API ${method} ${path}: exhausted retries`)
    },

    get(p: string) { return client.api('GET', p) },
    post(p: string, b: unknown) { return client.api('POST', p, b) },
    put(p: string, b: unknown) { return client.api('PUT', p, b) },
    del(p: string) { return client.api('DELETE', p) },
  }
  return client
}

// ── Access file management ─────────────────────────────────────────────────

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

export function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      typingHeartbeat: parsed.typingHeartbeat,
      progressStatus: parsed.progressStatus,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    sharedLog.error('access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

// ── Gate ────────────────────────────────────────────────────────────────────
// Accepts accessOps callbacks to decouple from process-local state
// (BOOT_ACCESS, STATIC mode, etc.)

export type AccessOps = {
  load(): Access
  save(a: Access): void
}

export type MentionContext = {
  botUsername: string
  sentIds: Set<string>
}

export async function gate(
  post: any,
  channelType: string,
  ops: AccessOps,
  mentionCtx?: MentionContext,
): Promise<GateResult> {
  const access = ops.load()
  const pruned = pruneExpired(access)
  if (pruned) ops.save(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = post.user_id as string
  const isDM = channelType === 'D'

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        ops.save(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: post.channel_id,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    ops.save(access)
    return { action: 'pair', code, isResend: false }
  }

  const channelId = post.channel_id as string
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }

  // Webhook fast-path: bypass allowFrom/requireMention if channel opted in
  // and the sender-asserted override_username matches the allowlist.
  const isWebhook = post.props?.from_webhook === 'true'
  if (isWebhook && policy.forwardWebhooks) {
    const allowed = policy.forwardWebhooks.allowedSources ?? []
    const overrideName = typeof post.props?.override_username === 'string'
      ? post.props.override_username
      : ''
    // Anonymous webhooks (no override_username) are always dropped, even with "*".
    if (overrideName && (allowed.includes('*') || allowed.includes(overrideName))) {
      return { action: 'deliver', access }
    }
    // Explicitly opted-in but mismatched source — drop instead of falling through
    // to the normal gate (regular user gating doesn't apply to webhook posts).
    return { action: 'drop' }
  }

  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  const mentioned = mentionCtx
    ? isMentioned(post, access.mentionPatterns, mentionCtx.botUsername, mentionCtx.sentIds)
    : isMentionedInText(post, access.mentionPatterns)
  if (requireMention && !mentioned) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

// ── Mention detection ──────────────────────────────────────────────────────
// Separated into text-only check (shared) and full check (caller provides
// botUsername and recentSentIds).

/** Check only text content and custom patterns — no process-local state. */
function isMentionedInText(post: any, extraPatterns?: string[]): boolean {
  const text = (post.message ?? '') as string
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

/** Full mention check — caller provides process-local state. */
export function isMentioned(
  post: any,
  extraPatterns: string[] | undefined,
  botUsername: string,
  sentIds: Set<string>,
): boolean {
  const text = (post.message ?? '') as string
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) {
    return true
  }
  if (post.root_id && sentIds.has(post.root_id)) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ── Chunking ───────────────────────────────────────────────────────────────

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── File utilities ─────────────────────────────────────────────────────────

export function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function safeAttName(info: any): string {
  return (info.name ?? info.id ?? 'file').replace(/[\[\]\r\n;]/g, '_')
}

// ── Per-chat notes ─────────────────────────────────────────────────────────

export function notesPath(chatId: string): string {
  return join(MEMORY_DIR, `${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function readNotes(chatId: string): Record<string, NoteEntry> {
  try {
    const raw = readFileSync(notesPath(chatId), 'utf8')
    const parsed = JSON.parse(raw) as NotesFile
    return parsed.notes ?? {}
  } catch {
    return {}
  }
}

export function writeNotes(chatId: string, notes: Record<string, NoteEntry>): void {
  mkdirSync(MEMORY_DIR, { recursive: true })
  const p = notesPath(chatId)
  const tmp = `${p}.tmp-${Date.now()}`
  writeFileSync(tmp, JSON.stringify({ notes } as NotesFile, null, 2))
  chmodSync(tmp, 0o600)
  renameSync(tmp, p)
}

export function formatNotesPrefix(chatId: string): string {
  const notes = readNotes(chatId)
  const keys = Object.keys(notes)
  if (keys.length === 0) return ''
  const lines = keys.map(k => `${k}: ${notes[k].content}`)
  return `[notes for this chat]\n${lines.join('\n')}\n[/notes]\n\n`
}

// ── Per-chat mode ──────────────────────────────────────────────────────────

export function modePath(chatId: string): string {
  return join(MODES_DIR, `${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function readMode(chatId: string): ChatMode | null {
  try {
    return JSON.parse(readFileSync(modePath(chatId), 'utf8'))
  } catch { return null }
}

export function writeMode(chatId: string, m: ChatMode): void {
  mkdirSync(MODES_DIR, { recursive: true })
  const p = modePath(chatId)
  const tmp = `${p}.tmp-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(m))
  chmodSync(tmp, 0o600)
  renameSync(tmp, p)
}

export function clearMode(chatId: string): void {
  try { unlinkSync(modePath(chatId)) } catch {}
}

// ── Per-channel schedules ─────────────────────────────────────────────────

export function schedulesPath(channelId: string): string {
  return join(SCHEDULES_DIR, `${channelId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function readSchedules(channelId: string): ScheduleEntry[] {
  try {
    const raw = readFileSync(schedulesPath(channelId), 'utf8')
    const parsed = JSON.parse(raw) as { schedules?: ScheduleEntry[] }
    return parsed.schedules ?? []
  } catch {
    return []
  }
}

export function writeSchedules(channelId: string, schedules: ScheduleEntry[]): void {
  mkdirSync(SCHEDULES_DIR, { recursive: true })
  const p = schedulesPath(channelId)
  const tmp = `${p}.tmp-${Date.now()}`
  writeFileSync(tmp, JSON.stringify({ schedules }, null, 2))
  chmodSync(tmp, 0o600)
  renameSync(tmp, p)
}

export function generateScheduleId(): string {
  return 'sch_' + randomBytes(4).toString('hex')
}
