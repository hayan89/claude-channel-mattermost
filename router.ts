#!/usr/bin/env bun
/**
 * Mattermost channel router — coordinator daemon for per-channel Claude isolation.
 *
 * NOT an MCP server. Manages:
 * - Mattermost WebSocket connection
 * - Per-channel Claude Code subprocess lifecycle
 * - Message routing via file-based inbox IPC
 *
 * Usage: bun run router
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, watch,
} from 'fs'
import { join, resolve, basename } from 'path'
import { Cron } from 'croner'

import {
  STATE_DIR, APPROVED_DIR, SCHEDULES_DIR,
  SCHEDULED_RE,
  type MmClient, type MentionContext, type InboxMessage,
  loadEnvFile, createMmClient, createLogger,
  readAccessFile, saveAccess, readSchedules,
  gate, safeAttName,
  type AccessOps,
} from './shared.js'

// ── .env loader ────────────────────────────────────────────────────────────

loadEnvFile()

const MATTERMOST_URL = process.env.MATTERMOST_URL
const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN
const PLUGIN_DIR = resolve('.')
const MAX_SESSIONS = parseInt(process.env.MATTERMOST_MAX_SESSIONS ?? '10')
const IDLE_TIMEOUT_MS = parseInt(process.env.MATTERMOST_IDLE_TIMEOUT ?? String(30 * 60 * 1000))
const SESSIONS_DIR = join(STATE_DIR, 'sessions')

const log = createLogger('router')

if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
  log.error('MATTERMOST_URL and MATTERMOST_TOKEN required')
  process.exit(1)
}

// ── Error handlers ─────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  log.error(`unhandled rejection: ${err}`)
})
process.on('uncaughtException', err => {
  log.error(`uncaught exception: ${err}`)
})

// ── Mattermost REST client ─────────────────────────────────────────────────

const mm: MmClient = createMmClient(
  MATTERMOST_URL.replace(/\/+$/, ''),
  MATTERMOST_TOKEN,
)

// ── Access ops for gate() ──────────────────────────────────────────────────
// Router is the sole writer of access.json.

const accessOps: AccessOps = {
  load: readAccessFile,
  save: saveAccess,
}

// ── Process-local state ────────────────────────────────────────────────────

const recentSentIds = new Set<string>()
const dmChannelToUser = new Map<string, string>()

// ── Session management ─────────────────────────────────────────────────────

type ChannelSession = {
  channelId: string
  claudeProcess: ReturnType<typeof Bun.spawn> | null
  lastActivity: number
  state: 'starting' | 'ready' | 'stopping'
  inboxDir: string
  sessionDir: string
  messageQueue: InboxMessage[]
}

const sessions = new Map<string, ChannelSession>()

function createSession(channelId: string): ChannelSession {
  const sessionDir = join(SESSIONS_DIR, channelId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const inboxDir = join(sessionDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })

  // Clean up old ready file
  try { rmSync(join(sessionDir, 'ready'), { force: true }) } catch {}

  const session: ChannelSession = {
    channelId,
    claudeProcess: null,
    lastActivity: Date.now(),
    state: 'starting',
    inboxDir,
    sessionDir,
    messageQueue: [],
  }
  sessions.set(channelId, session)

  log.info(`spawning Claude for channel ${channelId}`)

  const stdoutLog = join(sessionDir, 'claude.stdout.log')
  const stderrLog = join(sessionDir, 'claude.stderr.log')

  // Use `script` to allocate a PTY — without a TTY, Claude CLI enters
  // --print mode instead of interactive/channel-listening mode.
  const claudeCmd = [
    'claude',
    '--dangerously-skip-permissions',
    '--plugin-dir', PLUGIN_DIR,
    '--dangerously-load-development-channels', 'plugin:mattermost@inline',
  ].join(' ')

  const proc = Bun.spawn([
    'script', '-q', '-c', claudeCmd, '/dev/null',
  ], {
    env: {
      ...process.env,
      MATTERMOST_CHANNEL_SCOPE: channelId,
      MATTERMOST_SESSION_DIR: sessionDir,
      TERM: process.env.TERM || 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  session.claudeProcess = proc

  // Auto-confirm development channel dialog
  setTimeout(() => {
    try {
      proc.stdin.write(new Uint8Array([0x0d]))
      proc.stdin.flush()
    } catch {}
  }, 1500)

  // Pipe stdout/stderr to log files
  pipeToLog(proc.stdout, stdoutLog)
  pipeToLog(proc.stderr, stderrLog)

  // Process exit detection
  proc.exited.then(code => {
    log.info(`channel ${channelId} claude exited (code ${code})`)
    if (sessions.get(channelId) === session) {
      sessions.delete(channelId)
    }
  })

  // Watch for ready signal
  watchForReady(session)

  return session
}

function pipeToLog(stream: ReadableStream<Uint8Array> | null, logPath: string): void {
  if (!stream) return
  const writer = Bun.file(logPath).writer()
  const reader = stream.getReader()
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        writer.write(value)
        writer.flush()
      }
    } catch {}
    writer.end()
  })()
}

function watchForReady(session: ChannelSession): void {
  const readyFile = join(session.sessionDir, 'ready')
  const timeout = setTimeout(() => {
    if (session.state === 'starting') {
      log.error(`channel ${session.channelId} startup timeout (30s)`)
      stopSession(session.channelId)
    }
  }, 30_000)

  const check = setInterval(() => {
    try {
      statSync(readyFile)
      // Ready!
      clearTimeout(timeout)
      clearInterval(check)
      session.state = 'ready'
      log.info(`channel ${session.channelId} ready`)

      // Flush queued messages
      for (const msg of session.messageQueue) {
        writeToInbox(session, msg)
      }
      session.messageQueue = []
    } catch {
      // Not ready yet
    }
  }, 500)

  // Clean up on process exit
  session.claudeProcess?.exited.then(() => {
    clearTimeout(timeout)
    clearInterval(check)
  })
}

function stopSession(channelId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  session.state = 'stopping'

  if (session.claudeProcess) {
    log.info(`stopping channel ${channelId}`)
    session.claudeProcess.kill('SIGTERM')

    // Force kill after 5s
    setTimeout(() => {
      try { session.claudeProcess?.kill('SIGKILL') } catch {}
    }, 5000)
  }

  sessions.delete(channelId)
}

function ensureSession(channelId: string): ChannelSession {
  const existing = sessions.get(channelId)
  if (existing && existing.state !== 'stopping') return existing

  // Evict oldest idle session if at capacity
  if (sessions.size >= MAX_SESSIONS) {
    const idle = [...sessions.entries()]
      .filter(([, s]) => s.state === 'ready')
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity)
    if (idle.length > 0) {
      log.info(`evicting idle session for channel ${idle[0][0]}`)
      stopSession(idle[0][0])
    } else {
      log.error(`max sessions (${MAX_SESSIONS}) reached, all active`)
      // Still try to create — it'll work if a session finished between the check
    }
  }

  return createSession(channelId)
}

// ── Message routing ────────────────────────────────────────────────────────

function routeMessage(channelId: string, message: InboxMessage): void {
  const session = ensureSession(channelId)
  session.lastActivity = Date.now()

  if (session.state === 'starting') {
    session.messageQueue.push(message)
    return
  }

  writeToInbox(session, message)
}

function writeToInbox(session: ChannelSession, message: InboxMessage): void {
  const filename = `${Date.now()}-${message.postId}.json`
  const tmpPath = join(session.inboxDir, `.tmp-${filename}`)
  const finalPath = join(session.inboxDir, filename)
  writeFileSync(tmpPath, JSON.stringify(message))
  renameSync(tmpPath, finalPath)
}

// ── Idle session cleanup ───────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  for (const [channelId, session] of sessions) {
    if (session.state === 'ready' && now - session.lastActivity > IDLE_TIMEOUT_MS) {
      log.info(`idle timeout for channel ${channelId}`)
      stopSession(channelId)
    }
  }
}, 60_000).unref()

// ── Approval polling ───────────────────────────────────────────────────────

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }

    void (async () => {
      try {
        await mm.post('/posts', {
          channel_id: dmChannelId,
          message: 'Paired! Say hi to Claude.',
        })
        rmSync(file, { force: true })
        log.debug(`approved ${senderId}`)
      } catch (err) {
        log.error(`failed to send approval confirm: ${err}`)
        rmSync(file, { force: true })
      }
    })()
  }
}

setInterval(checkApprovals, 5000).unref()

// ── WebSocket connection ───────────────────────────────────────────────────

let ws: WebSocket | null = null
let shuttingDown = false
let reconnectDelay = 5000

function connectWebSocket(): void {
  if (shuttingDown) return

  const wsUrl = mm.url.replace(/^http/, 'ws') + '/api/v4/websocket'
  ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    reconnectDelay = 5000
    ws!.send(JSON.stringify({
      seq: 1,
      action: 'authentication_challenge',
      data: { token: mm.token },
    }))
    log.info('websocket connected')
  })

  ws.addEventListener('message', (event: MessageEvent) => {
    let data: any
    try {
      data = JSON.parse(String(event.data))
    } catch { return }

    if (data.event === 'posted' && data.data?.post) {
      let post: any
      try {
        post = JSON.parse(data.data.post)
      } catch { return }

      // Skip own messages — except scheduled triggers
      if (post.user_id === mm.botUserId) {
        const scheduledMatch = ((post.message ?? '') as string).match(SCHEDULED_RE)
        if (!scheduledMatch) return  // normal bot message — skip

        // Scheduled trigger: bypass gate(), route directly to channel
        const scheduleId = scheduledMatch[1]
        const actualPrompt = (post.message as string).replace(scheduledMatch[0], '')
        const chatId = post.channel_id as string

        const inboxMessage: InboxMessage = {
          postId: post.id,
          channelId: chatId,
          userId: mm.botUserId,
          userName: 'scheduled-task',
          message: actualPrompt,
          rootId: undefined,
          createAt: post.create_at,
          channelType: data.data.channel_type ?? '',
          scheduledId: scheduleId,
        }
        routeMessage(chatId, inboxMessage)
        return
      }
      // Skip system posts
      if (post.type?.trim()) return

      const channelType = data.data.channel_type ?? ''
      const senderName = data.data.sender_name ?? ''
      handleInbound(post, channelType, senderName).catch(e =>
        log.error(`handleInbound failed: ${e}`),
      )
    }
  })

  ws.addEventListener('close', () => {
    if (shuttingDown) return
    log.info(`ws closed, reconnecting in ${reconnectDelay / 1000}s`)
    setTimeout(connectWebSocket, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  })

  ws.addEventListener('error', () => {
    log.error('ws error')
  })
}

// ── Inbound message handling ───────────────────────────────────────────────

async function handleInbound(post: any, channelType: string, senderName: string): Promise<void> {
  const mentionCtx: MentionContext = { botUsername: mm.botUsername, sentIds: recentSentIds }
  const result = await gate(post, channelType, accessOps, mentionCtx)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await mm.post('/posts', {
        channel_id: post.channel_id,
        message: `${lead} — run in Claude Code:\n\n\`/mattermost:access pair ${result.code}\``,
      })
    } catch (err) {
      log.error(`failed to send pairing code: ${err}`)
    }
    return
  }

  const access = result.access
  const chatId = post.channel_id as string

  // DM channel cache
  if (channelType === 'D') {
    dmChannelToUser.set(chatId, post.user_id)
  }

  // Typing indicator — immediate response
  void mm.post('/users/me/typing', {
    channel_id: chatId,
    ...(post.root_id ? { parent_id: post.root_id } : {}),
  }).catch(() => {})

  // Ack reaction — fire-and-forget
  if (access.ackReaction) {
    void mm.post('/reactions', {
      user_id: mm.botUserId,
      post_id: post.id,
      emoji_name: access.ackReaction,
    }).catch(() => {})
  }

  // Attachment metadata
  const fileIds: string[] = post.file_ids ?? []
  const atts: InboxMessage['attachments'] = []
  if (fileIds.length > 0) {
    const infos = await Promise.all(
      fileIds.map(id => mm.get(`/files/${id}/info`).catch(() => null)),
    )
    for (const info of infos) {
      if (!info) continue
      const kb = (info.size / 1024).toFixed(0)
      atts.push({
        name: safeAttName(info),
        mimeType: info.mime_type ?? 'unknown',
        sizeKB: kb,
      })
    }
  }

  // Plan mode command detection
  const msg = (post.message ?? '') as string
  const planMatch = msg.match(/^!plan\b\s*([\s\S]*)/)
  const goMatch = msg.match(/^!(go|execute|approve)\b\s*([\s\S]*)/)
  const cancelMatch = msg.match(/^!cancel\b\s*([\s\S]*)/)

  let modeCommand: InboxMessage['modeCommand']
  let modeExtra: string | undefined
  let effectiveMessage = msg

  if (planMatch) {
    modeCommand = 'plan'
    modeExtra = planMatch[1].trim() || undefined
    effectiveMessage = planMatch[1].trim() || '(plan mode activated — awaiting request)'
  } else if (goMatch) {
    modeCommand = 'go'
    modeExtra = goMatch[2].trim() || undefined
    effectiveMessage = goMatch[2].trim() || '(execute the plan)'
  } else if (cancelMatch) {
    modeCommand = 'cancel'
    modeExtra = cancelMatch[1].trim() || undefined
    effectiveMessage = cancelMatch[1].trim() || '(plan cancelled)'
  }

  const inboxMessage: InboxMessage = {
    postId: post.id,
    channelId: chatId,
    userId: post.user_id,
    userName: senderName || post.user_id,
    message: effectiveMessage,
    rootId: post.root_id || undefined,
    fileIds: fileIds.length > 0 ? fileIds : undefined,
    createAt: post.create_at,
    channelType,
    attachments: atts.length > 0 ? atts : undefined,
    modeCommand,
    modeExtra,
  }

  routeMessage(chatId, inboxMessage)
}

// ── App cron scheduler ────────────────────────────────────────────────────

const cronJobs = new Map<string, Cron>()

function channelIdFromPath(filename: string): string {
  return basename(filename, '.json')
}

function loadAllSchedules(): void {
  mkdirSync(SCHEDULES_DIR, { recursive: true })
  let files: string[]
  try {
    files = readdirSync(SCHEDULES_DIR).filter(f => f.endsWith('.json'))
  } catch { return }
  for (const file of files) {
    const channelId = channelIdFromPath(file)
    reconcileChannel(channelId)
  }
}

function reconcileChannel(channelId: string): void {
  // Stop existing jobs for this channel
  for (const [id, job] of cronJobs) {
    if (id.startsWith(`${channelId}:`)) {
      job.stop()
      cronJobs.delete(id)
    }
  }

  const schedules = readSchedules(channelId)
  for (const entry of schedules) {
    const key = `${channelId}:${entry.id}`
    try {
      const job = new Cron(entry.cron, () => {
        fireSchedule(channelId, entry.id, entry.prompt).catch(err =>
          log.error(`schedule trigger failed ${entry.id}: ${err}`),
        )
      })
      cronJobs.set(key, job)
      log.info(`loaded schedule ${entry.id} cron=${entry.cron}`)
    } catch (err) {
      log.error(`invalid cron for ${entry.id}: ${err}`)
    }
  }
}

async function fireSchedule(channelId: string, scheduleId: string, prompt: string): Promise<void> {
  log.info(`firing schedule ${scheduleId} for channel ${channelId}`)
  await mm.post('/posts', {
    channel_id: channelId,
    message: `[scheduled:${scheduleId}] ${prompt}`,
  })
}

function stopAllJobs(): void {
  for (const [, job] of cronJobs) {
    job.stop()
  }
  cronJobs.clear()
}

// Watch schedules directory for changes (debounced)
let watchDebounce: ReturnType<typeof setTimeout> | null = null
function startScheduleWatcher(): void {
  mkdirSync(SCHEDULES_DIR, { recursive: true })
  watch(SCHEDULES_DIR, (_event, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    if (watchDebounce) clearTimeout(watchDebounce)
    watchDebounce = setTimeout(() => {
      const channelId = channelIdFromPath(filename)
      log.info(`schedule file changed: ${filename}, reconciling`)
      reconcileChannel(channelId)
    }, 200)
  })
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log.info('shutting down')

  // Stop all cron jobs
  stopAllJobs()

  // Close WebSocket
  if (ws) {
    try { ws.close() } catch {}
  }

  // SIGTERM all sessions
  for (const [channelId] of sessions) {
    stopSession(channelId)
  }

  // Force exit after 7s (5s SIGTERM wait + 2s buffer)
  setTimeout(() => {
    log.info('force exit')
    process.exit(0)
  }, 7000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Main init ──────────────────────────────────────────────────────────────

mkdirSync(SESSIONS_DIR, { recursive: true })

void (async () => {
  try {
    const me = await mm.get('/users/me')
    mm.botUserId = me.id
    mm.botUsername = me.username
    log.info(`authenticated as @${mm.botUsername}`)
    log.info(`max sessions=${MAX_SESSIONS}, idle timeout=${IDLE_TIMEOUT_MS / 1000}s`)
    loadAllSchedules()
    startScheduleWatcher()
    connectWebSocket()
  } catch (err) {
    log.error(`auth failed: ${err}`)
    process.exit(1)
  }
})()
