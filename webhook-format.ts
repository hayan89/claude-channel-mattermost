/**
 * Webhook payload formatting for Mattermost incoming webhooks.
 *
 * Source-agnostic: assumes Mattermost-standard (Slack-compatible) attachment
 * schema. Grafana, GitHub, PagerDuty, and most SaaS senders use this format.
 *
 * The output is always wrapped in a fenced code block with prompt-injection
 * mitigations applied, so the LLM treats the body as untrusted data rather
 * than instructions.
 */

type Field = {
  title?: string
  value?: string
  short?: boolean
}

type Attachment = {
  fallback?: string
  pretext?: string
  title?: string
  title_link?: string
  text?: string
  fields?: Field[]
  color?: string
  image_url?: string
  thumb_url?: string
  footer?: string
  footer_icon?: string
  author_name?: string
  author_link?: string
  ts?: string | number
}

// Mattermost serializes props.attachments as either an array or a JSON string.
function readAttachments(post: any): Attachment[] {
  const raw = post?.props?.attachments
  if (!raw) return []
  if (Array.isArray(raw)) return raw as Attachment[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as Attachment[]) : []
    } catch {
      return []
    }
  }
  return []
}

// Strip dangerous chars from input then insert protective separators into
// fence-breakers and <channel> tags. Two-pass so input zero-widths can't
// pre-inject the protective ones.
function escapeForFence(s: string): string {
  if (!s) return ''
  // Pass 1: strip dangerous chars from input
  let out = s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
  // Pass 2: insert ZWSP into fence-breakers and channel tags
  out = out
    .replace(/```/g, '`\u200B``')
    .replace(/<\s*\/?\s*channel\b/gi, m =>
      m.replace(/channel/i, c => c.slice(0, 3) + '\u200B' + c.slice(3)),
    )
  return out
}

function fmtField(f: Field): string {
  const t = escapeForFence(f.title ?? '')
  const v = escapeForFence(f.value ?? '')
  if (!t && !v) return ''
  if (t && v) return `${t}: ${v}`
  return t || v
}

function fmtAttachment(a: Attachment): string {
  const lines: string[] = []
  if (a.author_name) lines.push(`Author: ${escapeForFence(a.author_name)}`)
  if (a.pretext) lines.push(escapeForFence(a.pretext))
  if (a.title) {
    const t = escapeForFence(a.title)
    lines.push(a.title_link ? `${t} (${escapeForFence(a.title_link)})` : t)
  }
  if (a.text) lines.push(escapeForFence(a.text))
  if (a.fields && a.fields.length > 0) {
    for (const f of a.fields) {
      const line = fmtField(f)
      if (line) lines.push(line)
    }
  }
  if (a.color) lines.push(`Color: ${escapeForFence(a.color)}`)
  if (a.image_url) lines.push(`Image: ${escapeForFence(a.image_url)}`)
  if (a.thumb_url) lines.push(`Thumb: ${escapeForFence(a.thumb_url)}`)
  if (a.footer) lines.push(`Footer: ${escapeForFence(a.footer)}`)
  if (a.ts) lines.push(`Timestamp: ${escapeForFence(String(a.ts))}`)
  // Fallback only used if nothing else rendered
  if (lines.length === 0 && a.fallback) lines.push(escapeForFence(a.fallback))
  return lines.join('\n')
}

/**
 * Format a Mattermost incoming-webhook post into a Claude-safe text block.
 *
 * Returns `null` when both `post.message` and `post.props.attachments` are
 * empty — caller should drop such payloads with a warn log rather than feed
 * an empty context to the LLM.
 *
 * Output is wrapped in a ```text fenced block with control/BiDi/zero-width
 * characters stripped and fence-breakers / `<channel>` tags neutralized.
 */
export function formatWebhookAttachments(post: any): string | null {
  const attachments = readAttachments(post)
  const message = typeof post?.message === 'string' ? post.message : ''

  if (attachments.length === 0 && !message.trim()) return null

  const sections: string[] = []
  if (message.trim()) {
    sections.push(escapeForFence(message))
  }
  for (const a of attachments) {
    const block = fmtAttachment(a)
    if (block) sections.push(block)
  }

  if (sections.length === 0) return null

  const body = sections.join('\n\n---\n')
  return '```text\n' + body + '\n```'
}

// Exported for tests
export const __internal = { escapeForFence, readAttachments }
