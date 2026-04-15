import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  stripAnsi,
  ApprovalDetector,
  resolveChoice,
  isSensitiveTarget,
  defaultSensitiveKeywords,
  parseSensitiveEnv,
  type Prompt,
} from '../approval-bridge.js'

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'grafana-edit.log')

describe('stripAnsi', () => {
  test('removes CSI color sequences', () => {
    expect(stripAnsi('\x1b[1mhello\x1b[22m')).toBe('hello')
    expect(stripAnsi('\x1b[38;5;231mtext\x1b[39m')).toBe('text')
  })

  test('removes OSC sequences', () => {
    expect(stripAnsi('before\x1b]0;title\x07after')).toBe('beforeafter')
  })

  test('preserves newlines and tabs', () => {
    expect(stripAnsi('a\nb\tc')).toBe('a\nb\tc')
  })

  test('removes other control bytes', () => {
    expect(stripAnsi('a\x01b\x07c')).toBe('abc')
  })
})

describe('ApprovalDetector — tool approval', () => {
  test('detects Edit prompt from grafana fixture', () => {
    const log = readFileSync(FIXTURE_PATH, 'utf8')
    const det = new ApprovalDetector()
    det.feed(log)
    const p = det.detect()
    expect(p).not.toBeNull()
    if (!p) return
    expect(p.kind).toBe('tool-approval')
    expect(p.question).toMatch(/Do you want to make this edit/)
    expect(p.options.length).toBe(3)
    expect(p.options[0]).toEqual({ index: 1, label: 'Yes' })
    expect(p.options[2].label).toBe('No')
    expect(p.defaultDenyIndex).toBe(3)
  })

  test('debounces same prompt within 5s', () => {
    const log = readFileSync(FIXTURE_PATH, 'utf8')
    const det = new ApprovalDetector()
    det.feed(log)
    const p1 = det.detect()
    expect(p1).not.toBeNull()
    // 같은 buffer 상태에서 다시 detect — debounce로 null
    const p2 = det.detect()
    expect(p2).toBeNull()
  })

  test('skips when no Esc/Tab/Enter hint line', () => {
    const det = new ApprovalDetector()
    det.feed('Do you want to make this edit?\n1. Yes\n2. No\n')
    expect(det.detect()).toBeNull()
  })

  test('requires at least 2 options', () => {
    const det = new ApprovalDetector()
    det.feed('Do you want to make this edit?\n1. Yes\nEsc to cancel\n')
    expect(det.detect()).toBeNull()
  })
})

describe('ApprovalDetector — exit plan mode', () => {
  test('detects Would you like to proceed pattern', () => {
    const txt = `
Plan ready.

Would you like to proceed?
1. Yes, and auto-accept edits
2. Yes, and manually approve edits
3. No, keep planning

Esc to cancel
`
    const det = new ApprovalDetector()
    det.feed(txt)
    const p = det.detect()
    expect(p).not.toBeNull()
    if (!p) return
    expect(p.kind).toBe('exit-plan-mode')
    expect(p.options.length).toBe(3)
    expect(p.defaultDenyIndex).toBe(3)
  })
})

describe('resolveChoice', () => {
  const prompt: Prompt = {
    kind: 'tool-approval',
    question: 'Do you want to make this edit to file.txt?',
    options: [
      { index: 1, label: 'Yes' },
      { index: 2, label: 'Yes, allow all edits in workspace/ during this session' },
      { index: 3, label: 'No' },
    ],
    defaultDenyIndex: 3,
    hash: 'abc',
  }

  test('numeric direct match', async () => {
    expect(await resolveChoice('1', prompt)).toEqual({ index: 1, reason: 'numeric' })
    expect(await resolveChoice('2.', prompt)).toEqual({ index: 2, reason: 'numeric' })
    expect(await resolveChoice('3번', prompt)).toEqual({ index: 3, reason: 'numeric' })
  })

  test('positive keywords map to first Yes option', async () => {
    expect(await resolveChoice('yes', prompt)).toEqual({ index: 1, reason: 'positive-keyword' })
    expect(await resolveChoice('네', prompt)).toEqual({ index: 1, reason: 'positive-keyword' })
    expect(await resolveChoice('확인', prompt)).toEqual({ index: 1, reason: 'positive-keyword' })
    expect(await resolveChoice('ok', prompt)).toEqual({ index: 1, reason: 'positive-keyword' })
  })

  test('negative keywords map to defaultDenyIndex', async () => {
    expect(await resolveChoice('no', prompt)).toEqual({ index: 3, reason: 'negative-keyword' })
    expect(await resolveChoice('취소', prompt)).toEqual({ index: 3, reason: 'negative-keyword' })
    expect(await resolveChoice('아니', prompt)).toEqual({ index: 3, reason: 'negative-keyword' })
  })

  test('label substring match — unique', async () => {
    const r = await resolveChoice('allow all edits', prompt)
    expect(r).toMatchObject({ index: 2 })
  })

  test('empty input is ambiguous', async () => {
    expect(await resolveChoice('', prompt)).toEqual({ ambiguous: true })
    expect(await resolveChoice('   ', prompt)).toEqual({ ambiguous: true })
  })

  test('mixed positive+negative is ambiguous (no classifier)', async () => {
    expect(await resolveChoice('yes but no', prompt)).toEqual({ ambiguous: true })
  })

  test('unrelated text falls through to ambiguous when no classifier', async () => {
    const r = await resolveChoice('근데 이거 말고 다른거 해줘', prompt)
    expect(r).toEqual({ ambiguous: true })
  })

  test('classifier fallback when ambiguous', async () => {
    const r = await resolveChoice('근데 이거 말고 다른거 해줘', prompt, async () => ({ index: 2 }))
    expect(r).toEqual({ index: 2, reason: 'llm' })
  })

  test('classifier returns null → ambiguous', async () => {
    const r = await resolveChoice('완전 모호한 답변', prompt, async () => ({ index: null }))
    expect(r).toEqual({ ambiguous: true })
  })
})

describe('sensitive target guard', () => {
  test('default keywords loaded', () => {
    const kw = defaultSensitiveKeywords()
    expect(kw).toContain('.claude.json')
    expect(kw).toContain('.env')
  })

  test('parseSensitiveEnv returns defaults on undefined/empty', () => {
    expect(parseSensitiveEnv(undefined)).toEqual(defaultSensitiveKeywords())
    expect(parseSensitiveEnv('')).toEqual(defaultSensitiveKeywords())
  })

  test('parseSensitiveEnv parses comma list', () => {
    expect(parseSensitiveEnv('foo, bar ,baz')).toEqual(['foo', 'bar', 'baz'])
  })

  test('isSensitiveTarget catches .claude.json in question', () => {
    const p: Prompt = {
      kind: 'tool-approval',
      question: 'Do you want to make this edit to .claude.json?',
      options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }],
      defaultDenyIndex: 2,
      hash: 'h',
    }
    expect(isSensitiveTarget(p, defaultSensitiveKeywords())).toBe('.claude.json')
  })

  test('isSensitiveTarget catches keyword in option label', () => {
    const p: Prompt = {
      kind: 'tool-approval',
      question: 'Edit file?',
      options: [
        { index: 1, label: 'Yes — overwrite ~/.config/credentials' },
        { index: 2, label: 'No' },
      ],
      defaultDenyIndex: 2,
      hash: 'h',
    }
    expect(isSensitiveTarget(p, defaultSensitiveKeywords())).toBe('credentials')
  })

  test('isSensitiveTarget returns null for safe target', () => {
    const p: Prompt = {
      kind: 'tool-approval',
      question: 'Do you want to make this edit to ~/some-file.txt?',
      options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }],
      defaultDenyIndex: 2,
      hash: 'h',
    }
    expect(isSensitiveTarget(p, defaultSensitiveKeywords())).toBeNull()
  })
})
