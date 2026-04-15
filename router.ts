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
  statSync, renameSync, watch, createWriteStream,
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

import {
  ApprovalDetector, resolveChoice, classifyWithClaude,
  isSensitiveTarget, parseSensitiveEnv,
  type Prompt,
} from './approval-bridge.js'

import { formatWebhookAttachments } from './webhook-format.js'

// ── .env loader ────────────────────────────────────────────────────────────

loadEnvFile()

const MATTERMOST_URL = process.env.MATTERMOST_URL
const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN
const PLUGIN_DIR = resolve('.')
const MAX_SESSIONS = parseInt(process.env.MATTERMOST_MAX_SESSIONS ?? '10')
const IDLE_TIMEOUT_MS = parseInt(process.env.MATTERMOST_IDLE_TIMEOUT ?? String(30 * 60 * 1000))
const SESSIONS_DIR = join(STATE_DIR, 'sessions')

// ── Approval bridge config ────────────────────────────────────────────────
type ApprovalBridgeMode = 'off' | 'detect-only' | 'full'
const APPROVAL_BRIDGE_MODE: ApprovalBridgeMode = (() => {
  const v = (process.env.MATTERMOST_APPROVAL_BRIDGE ?? 'off').toLowerCase()
  if (v === 'detect-only' || v === 'full') return v
  return 'off'
})()
const APPROVAL_TIMEOUT_MS = parseInt(process.env.MATTERMOST_APPROVAL_TIMEOUT ?? String(5 * 60 * 1000))
const SENSITIVE_KEYWORDS = parseSensitiveEnv(process.env.MATTERMOST_APPROVAL_SENSITIVE_PATHS)

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

type PendingApproval = {
  prompt: Prompt
  sentAt: number
  timeoutHandle: ReturnType<typeof setTimeout>
  reaskCount: number
}

type ChannelSession = {
  channelId: string
  claudeProcess: ReturnType<typeof Bun.spawn> | null
  lastActivity: number
  state: 'starting' | 'ready' | 'stopping'
  inboxDir: string
  sessionDir: string
  messageQueue: InboxMessage[]
  detector: ApprovalDetector | null
  awaitingApproval: PendingApproval | null
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
    detector: APPROVAL_BRIDGE_MODE === 'off' ? null : new ApprovalDetector(),
    awaitingApproval: null,
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

  // Pipe stdout/stderr to log files (append, with session marker).
  // detector는 stdout에만 연결 (stderr는 오탐/성능 회피).
  pipeToLog(proc.stdout, stdoutLog, channelId, session.detector ?? undefined, session)
  pipeToLog(proc.stderr, stderrLog, channelId)

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

const MAX_CLAUDE_LOG_BYTES = 20 * 1024 * 1024  // 20 MB cap before rotation

function pipeToLog(
  stream: ReadableStream<Uint8Array> | null,
  logPath: string,
  channelId: string,
  detector?: ApprovalDetector,
  session?: ChannelSession,
): void {
  if (!stream) return

  // Rotate if oversized (keep last .1 as backup)
  try {
    const size = statSync(logPath).size
    if (size > MAX_CLAUDE_LOG_BYTES) {
      try { rmSync(`${logPath}.1`, { force: true }) } catch {}
      renameSync(logPath, `${logPath}.1`)
    }
  } catch { /* file absent is fine */ }

  const out = createWriteStream(logPath, { flags: 'a' })
  out.write(`\n===== spawn ${channelId} @ ${new Date().toISOString()} =====\n`)

  // Flag-gated tee: detector 미전달이면 기존 단일 reader 경로로 즉시 롤백 가능.
  const [logStream, detectStream] = detector && session
    ? stream.tee()
    : [stream, null] as const

  const reader = logStream.getReader()
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        out.write(value)
      }
    } catch {}
    out.end()
  })()

  if (detector && session && detectStream) {
    const dReader = detectStream.getReader()
    void (async () => {
      try {
        while (true) {
          const { done, value } = await dReader.read()
          if (done) break
          detector.feed(value)
          const prompt = detector.detect()
          if (prompt) {
            void dispatchApproval(session, prompt).catch(err =>
              log.error(`dispatchApproval failed: ${err}`),
            )
          }
        }
      } catch {}
    })()
  }
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

// ── Approval bridge ────────────────────────────────────────────────────────

function formatApprovalMessage(prompt: Prompt, sensitiveHit: string | null): string {
  const optsText = prompt.options.map(o => `${o.index}. ${o.label}`).join('\n')
  if (sensitiveHit) {
    return [
      '⚠️ 중요 설정 편집 승인 요청 감지',
      '',
      `> ${prompt.question}`,
      '',
      optsText,
      '',
      `민감 키워드 \`${sensitiveHit}\` 가 감지돼 채널에서 자동 승인하지 않습니다.`,
      'CLI 세션에서 직접 처리해 주세요.',
      `${Math.floor(APPROVAL_TIMEOUT_MS / 60000)}분 내 처리되지 않으면 세션 hang 방지를 위해 자동 거부됩니다.`,
    ].join('\n')
  }
  return [
    '🔐 승인 요청',
    '',
    `> ${prompt.question}`,
    '',
    optsText,
    '',
    `${Math.floor(APPROVAL_TIMEOUT_MS / 60000)}분 내 응답 없으면 자동 거부됩니다. (숫자 또는 자연어 응답 가능)`,
  ].join('\n')
}

async function dispatchApproval(session: ChannelSession, prompt: Prompt): Promise<void> {
  // 같은 hash가 이미 대기 중이면 스킵
  if (session.awaitingApproval && session.awaitingApproval.prompt.hash === prompt.hash) return

  // 다른 prompt가 대기 중이었으면 timeout clear (새 것으로 교체)
  if (session.awaitingApproval) {
    clearTimeout(session.awaitingApproval.timeoutHandle)
    log.info(`channel ${session.channelId} approval replaced (new prompt)`)
  }

  const sensitiveHit = isSensitiveTarget(prompt, SENSITIVE_KEYWORDS)
  const message = formatApprovalMessage(prompt, sensitiveHit)

  log.info(`channel ${session.channelId} approval needed: ${prompt.kind} (${prompt.hash})${sensitiveHit ? ` SENSITIVE=${sensitiveHit}` : ''} mode=${APPROVAL_BRIDGE_MODE}`)

  if (APPROVAL_BRIDGE_MODE === 'detect-only') {
    return
  }

  // full mode
  try {
    await mm.post('/posts', {
      channel_id: session.channelId,
      message,
    })
  } catch (err) {
    log.error(`failed to send approval prompt: ${err}`)
  }

  const timeoutHandle = setTimeout(() => {
    if (!session.awaitingApproval || session.awaitingApproval.prompt.hash !== prompt.hash) return
    log.info(`channel ${session.channelId} approval timeout — auto-deny ${prompt.defaultDenyIndex}`)
    void mm.post('/posts', {
      channel_id: session.channelId,
      message: '⏱ 승인 시간 초과 — 자동 거부 처리합니다.',
    }).catch(() => {})
    injectChoice(session, prompt.defaultDenyIndex, prompt.hash)
    session.awaitingApproval = null
  }, APPROVAL_TIMEOUT_MS)

  session.awaitingApproval = {
    prompt,
    sentAt: Date.now(),
    timeoutHandle,
    reaskCount: 0,
  }
}

function injectChoice(session: ChannelSession, index: number, promptHash?: string): boolean {
  const proc = session.claudeProcess
  if (!proc) return false
  try {
    const stdin = proc.stdin as { write(data: Uint8Array): void; flush(): void }
    stdin.write(new TextEncoder().encode(`${index}\r`))
    stdin.flush()
    if (promptHash && session.detector) {
      session.detector.suppressHash(promptHash, 2_000)
    }
    return true
  } catch (err) {
    log.error(`channel ${session.channelId} stdin write failed: ${err}`)
    return false
  }
}

async function handleApprovalReply(session: ChannelSession, userText: string): Promise<boolean> {
  const pending = session.awaitingApproval
  if (!pending) return false

  // 민감 경로 안내 모드: 사용자 응답 무시하지 않고 그대로 통과 (CLI에서 처리하라는 안내).
  // 단, 사용자가 명시 거부를 보내면 즉시 거부 주입해서 hang을 짧게 끝낼 수 있게.
  const result = await resolveChoice(userText, pending.prompt, classifyWithClaude)

  if ('ambiguous' in result) {
    if (pending.reaskCount < 1) {
      pending.reaskCount += 1
      void mm.post('/posts', {
        channel_id: session.channelId,
        message: '❓ 선택을 명확히 답해주세요. 숫자 (1/2/3...) 또는 옵션 키워드로 회신.',
      }).catch(() => {})
      return true  // 메시지는 inbox로 포워드하지 않음
    }
    // 2회 실패 — inbox로 포워드 (일반 대화 가능성), 승인 대기는 유지
    return false
  }

  // 성공
  clearTimeout(pending.timeoutHandle)
  const ok = injectChoice(session, result.index, pending.prompt.hash)
  session.awaitingApproval = null
  if (ok) {
    const chosen = pending.prompt.options.find(o => o.index === result.index)
    void mm.post('/posts', {
      channel_id: session.channelId,
      message: `✅ 선택 반영: \`${result.index}. ${chosen?.label ?? ''}\` (${result.reason})`,
    }).catch(() => {})
  } else {
    void mm.post('/posts', {
      channel_id: session.channelId,
      message: '⚠️ 응답 주입 실패 — 세션을 재시작해야 할 수 있습니다.',
    }).catch(() => {})
  }
  return true
}

function clearPendingApproval(session: ChannelSession): void {
  if (session.awaitingApproval) {
    clearTimeout(session.awaitingApproval.timeoutHandle)
    session.awaitingApproval = null
  }
}

function stopSession(channelId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  session.state = 'stopping'

  clearPendingApproval(session)

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

  // Approval bridge: 승인 대기 중이면 응답으로 먼저 해석 (mode 명령은 통과)
  if (
    APPROVAL_BRIDGE_MODE === 'full' &&
    session.awaitingApproval &&
    !message.modeCommand
  ) {
    void handleApprovalReply(session, message.message).then(consumed => {
      if (consumed) return
      // 가로채지 않은 경우 일반 메시지로 처리
      if (session.state === 'starting') {
        session.messageQueue.push(message)
      } else {
        writeToInbox(session, message)
      }
    }).catch(err => log.error(`approval reply failed: ${err}`))
    return
  }

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

  // Webhook fast-path: format attachments and skip plan-mode parsing.
  const isWebhook = post.props?.from_webhook === 'true'
  if (isWebhook) {
    const overrideName = typeof post.props?.override_username === 'string'
      ? post.props.override_username
      : ''
    const formatted = formatWebhookAttachments(post)
    if (formatted == null) {
      log.info(`webhook drop (empty payload): channel=${chatId} source=${overrideName || 'unknown'} postId=${post.id}`)
      return
    }
    const inboxMessage: InboxMessage = {
      postId: post.id,
      channelId: chatId,
      userId: post.user_id,
      userName: overrideName || senderName || 'webhook',
      message: formatted,
      rootId: post.root_id || undefined,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      createAt: post.create_at,
      channelType,
      attachments: atts.length > 0 ? atts : undefined,
      isWebhook: true,
      webhookSource: overrideName || 'unknown',
    }
    routeMessage(chatId, inboxMessage)
    return
  }

  // Plan mode command detection (regular user messages only)
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
