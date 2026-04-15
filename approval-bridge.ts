/**
 * Approval bridge: Mattermost 채널 세션에서 Claude CLI의 selection-UI를
 * 텍스트 승인 플로우로 치환.
 *
 * Router가 spawn한 채널용 claude 자식 프로세스 한정. 사용자 CLI 세션은 영향 없음.
 *
 * Public API:
 *   - stripAnsi(s): ANSI escape 제거
 *   - ApprovalDetector: stdout chunk 스트림을 먹으면서 selection-UI 감지
 *   - resolveChoice(userText, options, classifier?): 사용자 응답 → 옵션 index
 *   - classifyWithClaude: LLM fallback (claude --print, HOME 격리, 세마포어)
 *   - isSensitiveTarget(prompt, blacklist?): 민감 경로 가드
 *   - defaultSensitiveKeywords / parseSensitiveEnv: 블랙리스트 로딩
 */

import { randomBytes, createHash } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── ANSI / VT strip ──────────────────────────────────────────────────────────

// CSI: ESC [ ... final-byte (0x40-0x7E)
// OSC: ESC ] ... (BEL or ESC \)
// Single-char ESC sequences: ESC = / > / ( / ) / etc.
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g
const OSC_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g
const OTHER_ESC_RE = /\x1b[=>()#][0-9A-Za-z]?/g
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g  // keep \n(\x0a), \t(\x09), \r(\x0d)

export function stripAnsi(s: string): string {
  return s
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(OTHER_ESC_RE, '')
    .replace(CTRL_RE, '')
}

// ── Prompt types ─────────────────────────────────────────────────────────────

export type PromptKind = 'tool-approval' | 'ask-question' | 'exit-plan-mode'

export type Prompt = {
  kind: PromptKind
  question: string
  options: { index: number; label: string }[]  // 1-based
  defaultDenyIndex: number
  hash: string
}

// ── Detector ─────────────────────────────────────────────────────────────────

const RING_MAX = 16 * 1024
const DEBOUNCE_MS = 5_000

const TOOL_Q_RE = /Do you want to (make this edit|run this command|create|proceed)[^\n]*/i
const EXIT_PLAN_Q_RE = /Would you like to proceed\?/i
const ASK_Q_HINT_RE = /(Esc to cancel|Tab to amend|Enter to confirm)/
const OPTION_LINE_RE = /^\s*(\d+)\.\s+(.+?)\s*$/

export class ApprovalDetector {
  private buf = ''
  private recentHashes = new Map<string, number>()  // hash → timestamp

  feed(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder('utf-8', { fatal: false }).decode(chunk)
    this.buf += stripAnsi(text)
    if (this.buf.length > RING_MAX) {
      this.buf = this.buf.slice(this.buf.length - RING_MAX)
    }
  }

  /** 현재 버퍼에서 프롬프트 하나 감지. 찾으면 debounce 적용 후 반환. */
  detect(): Prompt | null {
    // 이중 신호 요구: question 패턴 + Esc/Tab 힌트 라인
    if (!ASK_Q_HINT_RE.test(this.buf)) return null

    const toolM = this.buf.match(TOOL_Q_RE)
    const exitM = this.buf.match(EXIT_PLAN_Q_RE)

    let questionLine: string | null = null
    let kind: PromptKind = 'ask-question'
    let anchorIdx = -1

    if (toolM) {
      questionLine = toolM[0]
      kind = 'tool-approval'
      anchorIdx = toolM.index ?? -1
    } else if (exitM) {
      questionLine = exitM[0]
      kind = 'exit-plan-mode'
      anchorIdx = exitM.index ?? -1
    } else {
      // AskUserQuestion: 힌트 라인 근처에서 가장 가까운 '?'로 끝나는 라인 + 아래 옵션 리스트
      const hintIdx = this.buf.search(ASK_Q_HINT_RE)
      if (hintIdx < 0) return null
      const preceding = this.buf.slice(Math.max(0, hintIdx - 2000), hintIdx)
      const lines = preceding.split('\n')
      // 가장 최근 '?' 포함 라인
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim()
        if (t.endsWith('?') && t.length > 3 && t.length < 500) {
          questionLine = t
          break
        }
      }
      if (!questionLine) return null
      anchorIdx = this.buf.lastIndexOf(questionLine)
    }

    // anchor 이후의 옵션 리스트 파싱 (숫자 시작 라인)
    const tail = this.buf.slice(anchorIdx)
    const tailLines = tail.split('\n')
    const options: { index: number; label: string }[] = []
    for (const line of tailLines) {
      const m = line.match(OPTION_LINE_RE)
      if (m) {
        const idx = parseInt(m[1], 10)
        const label = m[2].trim()
        if (idx >= 1 && idx <= 9 && label.length > 0 && label.length < 200) {
          // 옵션이 이미 같은 index면 중단 (다음 프롬프트 시작)
          if (options.find(o => o.index === idx)) break
          options.push({ index: idx, label })
          if (options.length >= 9) break
        }
      } else if (options.length > 0 && /^\s*(Esc to|Tab to|Enter to)/.test(line)) {
        break  // 옵션 리스트 끝
      }
    }

    if (options.length < 2) return null

    // defaultDenyIndex: 'No'/'Cancel'/'Deny'로 시작하는 옵션 찾기, 없으면 마지막
    let defaultDenyIndex = options[options.length - 1].index
    for (const o of options) {
      if (/^\s*(No|Cancel|Deny|Don't|Skip)\b/i.test(o.label)) {
        defaultDenyIndex = o.index
        break
      }
    }

    const normalized = questionLine.trim() + '\n' + options.map(o => `${o.index}.${o.label}`).join('|')
    const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12)

    // debounce
    const now = Date.now()
    for (const [h, ts] of this.recentHashes) {
      if (now - ts > DEBOUNCE_MS) this.recentHashes.delete(h)
    }
    if (this.recentHashes.has(hash)) return null
    this.recentHashes.set(hash, now)

    return {
      kind,
      question: questionLine.trim(),
      options,
      defaultDenyIndex,
      hash,
    }
  }

  /** 방금 주입한 프롬프트 hash를 추가 억제 (재렌더 대비). */
  suppressHash(hash: string, durationMs = 2_000): void {
    this.recentHashes.set(hash, Date.now() - (DEBOUNCE_MS - durationMs))
  }
}

// ── Resolve user choice ──────────────────────────────────────────────────────

const POSITIVE_WORDS = [
  'yes', 'y', 'ok', 'okay', 'sure', 'go', 'apply', 'confirm', 'accept',
  '예', '네', '응', '확인', '승인', '적용', '좋아', '그래', '진행',
]
const NEGATIVE_WORDS = [
  'no', 'n', 'nope', 'cancel', 'abort', 'stop', 'deny', 'skip',
  '아니', '아뇨', '취소', '안해', '안함', '거부', '싫',
]

export type Classifier = (
  userText: string,
  question: string,
  options: { index: number; label: string }[],
) => Promise<{ index: number } | { index: null }>

export type ResolveResult =
  | { index: number; reason: string }
  | { ambiguous: true }

export async function resolveChoice(
  userText: string,
  prompt: Prompt,
  classifier?: Classifier,
): Promise<ResolveResult> {
  const raw = userText.trim()
  if (!raw) return { ambiguous: true }
  const lower = raw.toLowerCase()

  const options = prompt.options

  // 1. 숫자 단독 매칭 (1, 2, 3번, 2.)
  const numMatch = lower.match(/^\s*(\d)\s*(?:번|\.|\))?\s*$/)
  if (numMatch) {
    const n = parseInt(numMatch[1], 10)
    const opt = options.find(o => o.index === n)
    if (opt) return { index: opt.index, reason: 'numeric' }
  }

  // 2. 옵션 레이블 substring 매칭 (가장 긴 label match 우선)
  const labelMatches = options
    .map(o => ({ opt: o, score: substringScore(lower, o.label.toLowerCase()) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
  if (labelMatches.length === 1) {
    return { index: labelMatches[0].opt.index, reason: 'label-substring' }
  }
  // 여러 매치면 LLM fallback으로 넘김 (아래)

  // 3. 긍정/부정 키워드
  const hasPositive = POSITIVE_WORDS.some(w => wordBoundaryMatch(lower, w))
  const hasNegative = NEGATIVE_WORDS.some(w => wordBoundaryMatch(lower, w))

  if (hasPositive && !hasNegative) {
    const yesOpt = options.find(o => /^\s*Yes\b/i.test(o.label)) ?? options[0]
    return { index: yesOpt.index, reason: 'positive-keyword' }
  }
  if (hasNegative && !hasPositive) {
    return { index: prompt.defaultDenyIndex, reason: 'negative-keyword' }
  }

  // 4. LLM fallback (label 다중 매치 포함)
  if (classifier) {
    try {
      const res = await classifier(raw, prompt.question, options)
      if (res.index !== null && options.find(o => o.index === res.index)) {
        return { index: res.index, reason: 'llm' }
      }
    } catch {
      // fallthrough
    }
  }

  return { ambiguous: true }
}

function substringScore(userText: string, label: string): number {
  // label 전체 또는 일부 토큰이 userText에 등장하는지
  if (label.length < 3) return 0
  if (userText.includes(label)) return label.length
  const tokens = label.split(/[\s,·—\-]+/).filter(t => t.length >= 3)
  let sum = 0
  for (const t of tokens) {
    if (userText.includes(t)) sum += t.length
  }
  return sum
}

function wordBoundaryMatch(text: string, word: string): boolean {
  // 한글 포함 가능 — 단순 includes + 경계 휴리스틱
  const idx = text.indexOf(word)
  if (idx < 0) return false
  const before = idx > 0 ? text[idx - 1] : ' '
  const after = idx + word.length < text.length ? text[idx + word.length] : ' '
  const isBoundary = (ch: string) => !/[a-z0-9]/.test(ch)
  return isBoundary(before) && isBoundary(after)
}

// ── LLM fallback (claude --print) ────────────────────────────────────────────

const LLM_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_LLM = 2
let llmSlotsInUse = 0
const llmWaiters: Array<() => void> = []

async function acquireLlmSlot(): Promise<void> {
  if (llmSlotsInUse < MAX_CONCURRENT_LLM) {
    llmSlotsInUse++
    return
  }
  await new Promise<void>(resolve => llmWaiters.push(resolve))
  llmSlotsInUse++
}

function releaseLlmSlot(): void {
  llmSlotsInUse--
  const next = llmWaiters.shift()
  if (next) next()
}

/**
 * Claude CLI `--print` 1회성 호출로 사용자 응답을 옵션 index로 분류.
 * HOME 임시 디렉토리로 격리 → router 프로세스의 `~/.claude.json`과 경합 없음.
 * 30s 타임아웃, 전역 세마포어 2.
 */
export const classifyWithClaude: Classifier = async (userText, question, options) => {
  await acquireLlmSlot()
  const tmpHome = join(tmpdir(), `approval-bridge-${Date.now()}-${randomBytes(4).toString('hex')}`)
  try {
    mkdirSync(tmpHome, { recursive: true })
  } catch {}

  const optionsText = options.map(o => `${o.index}. ${o.label}`).join('\n')
  const promptText = `사용자가 다음 질문에 답했습니다.
질문: ${question}
옵션:
${optionsText}

사용자 응답: ${userText}

사용자가 선택한 옵션의 번호 하나만 JSON으로 답하세요. 예: {"index": 2}
해석 불가면 {"index": null}.`

  try {
    const proc = Bun.spawn([
      'claude',
      '--print',
      '--output-format=json',
      '--model=claude-haiku-4-5-20251001',
    ], {
      env: {
        HOME: tmpHome,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TERM: 'dumb',
      },
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin.write(promptText)
    await proc.stdin.end()

    const timeoutHandle = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
    }, LLM_TIMEOUT_MS)

    const stdoutText = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timeoutHandle)

    // claude --print --output-format=json 은 전체 응답을 감싼 JSON envelope 반환
    // 내부 메시지에서 {"index": N} 또는 {"index": null} 추출
    const m = stdoutText.match(/\{"index"\s*:\s*(\d+|null)\s*\}/)
    if (!m) return { index: null }
    if (m[1] === 'null') return { index: null }
    const n = parseInt(m[1], 10)
    if (!options.find(o => o.index === n)) return { index: null }
    return { index: n }
  } catch {
    return { index: null }
  } finally {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
    releaseLlmSlot()
  }
}

// ── Sensitive path guard ─────────────────────────────────────────────────────

const DEFAULT_SENSITIVE_KEYWORDS = [
  '.claude.json',
  '/.claude/settings',
  '.env',
  'credentials',
  'secret',
  'token',
  'private_key',
  'id_rsa',
]

export function defaultSensitiveKeywords(): string[] {
  return [...DEFAULT_SENSITIVE_KEYWORDS]
}

export function parseSensitiveEnv(envValue: string | undefined): string[] {
  if (!envValue) return defaultSensitiveKeywords()
  return envValue
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

export function isSensitiveTarget(prompt: Prompt, blacklist: string[]): string | null {
  const haystack = (prompt.question + '\n' + prompt.options.map(o => o.label).join('\n')).toLowerCase()
  for (const kw of blacklist) {
    if (haystack.includes(kw.toLowerCase())) return kw
  }
  return null
}
