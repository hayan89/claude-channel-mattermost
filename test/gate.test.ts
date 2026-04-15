import { test, expect, describe } from 'bun:test'
import { gate, type Access, type AccessOps, type MentionContext } from '../shared'

function makeOps(access: Access): AccessOps {
  let state = access
  return {
    load: () => state,
    save: (a: Access) => { state = a },
  }
}

function baseAccess(overrides: Partial<Access> = {}): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  }
}

function webhookPost(channelId: string, overrideName?: string, from_webhook = true): any {
  return {
    id: 'post-1',
    channel_id: channelId,
    user_id: 'webhook-owner-uid',
    message: '',
    type: '',
    props: {
      ...(from_webhook ? { from_webhook: 'true' } : {}),
      ...(overrideName !== undefined ? { override_username: overrideName } : {}),
    },
    create_at: Date.now(),
  }
}

function userPost(channelId: string, senderId: string, message: string): any {
  return {
    id: 'post-2',
    channel_id: channelId,
    user_id: senderId,
    message,
    type: '',
    props: {},
    create_at: Date.now(),
  }
}

const mentionCtx: MentionContext = { botUsername: 'bot', sentIds: new Set() }

describe('gate — webhook forwarding matrix', () => {
  const CHAN = 'chan-1'

  test('no forwardWebhooks policy → webhook dropped (fallthrough to group gate)', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: false, allowFrom: [] } },
    }))
    const result = await gate(webhookPost(CHAN, 'grafana'), 'O', ops, mentionCtx)
    // No allowFrom restriction, no requireMention → delivers via regular gate
    // But webhook senderId isn't in allowFrom list (empty = no restriction), so delivers
    expect(result.action).toBe('deliver')
  })

  test('no channel policy → drop', async () => {
    const ops = makeOps(baseAccess())
    const result = await gate(webhookPost(CHAN, 'grafana'), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('forwardWebhooks: [] → drop (opt-in but allowlist empty)', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: [] } } },
    }))
    const result = await gate(webhookPost(CHAN, 'grafana'), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('forwardWebhooks ["grafana"] + grafana → deliver', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['grafana'] } } },
    }))
    const result = await gate(webhookPost(CHAN, 'grafana'), 'O', ops, mentionCtx)
    expect(result.action).toBe('deliver')
  })

  test('forwardWebhooks ["grafana"] + github → drop (not in allowlist)', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['grafana'] } } },
    }))
    const result = await gate(webhookPost(CHAN, 'github'), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('forwardWebhooks ["grafana", "github"] + github → deliver', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['grafana', 'github'] } } },
    }))
    const result = await gate(webhookPost(CHAN, 'github'), 'O', ops, mentionCtx)
    expect(result.action).toBe('deliver')
  })

  test('forwardWebhooks ["*"] + any non-empty username → deliver', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*'] } } },
    }))
    expect((await gate(webhookPost(CHAN, 'grafana'), 'O', ops, mentionCtx)).action).toBe('deliver')
    expect((await gate(webhookPost(CHAN, 'random-unknown'), 'O', ops, mentionCtx)).action).toBe('deliver')
  })

  test('forwardWebhooks ["*"] + undefined override_username → drop (anonymous)', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*'] } } },
    }))
    const result = await gate(webhookPost(CHAN, undefined), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('forwardWebhooks ["*"] + empty string override_username → drop', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*'] } } },
    }))
    const result = await gate(webhookPost(CHAN, ''), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('forwardWebhooks ["*", "grafana"] → wildcard wins (deliver for any)', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*', 'grafana'] } } },
    }))
    expect((await gate(webhookPost(CHAN, 'anything'), 'O', ops, mentionCtx)).action).toBe('deliver')
  })

  test('forwardWebhooks does NOT apply to DM channels', async () => {
    const ops = makeOps(baseAccess({
      dmPolicy: 'allowlist',
      allowFrom: [],
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*'] } } },
    }))
    // DM channelType='D' — webhook post in DM should not use webhook fast-path
    const result = await gate(webhookPost(CHAN, 'grafana'), 'D', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('non-webhook post ignores forwardWebhooks and uses normal gate', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*'] } } },
    }))
    // Regular user post without @bot mention → requireMention=true → drop
    const result = await gate(userPost(CHAN, 'user-a', 'hello'), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('non-webhook post with @mention → deliver (regression: normal gate unchanged)', async () => {
    const ops = makeOps(baseAccess({
      groups: { [CHAN]: { requireMention: true, allowFrom: [], forwardWebhooks: { allowedSources: ['*'] } } },
    }))
    const result = await gate(userPost(CHAN, 'user-a', 'hey @bot please'), 'O', ops, mentionCtx)
    expect(result.action).toBe('deliver')
  })
})

describe('gate — regression: existing behavior unaffected', () => {
  test('disabled policy drops everything', async () => {
    const ops = makeOps(baseAccess({ dmPolicy: 'disabled' }))
    const result = await gate(webhookPost('any', 'grafana'), 'O', ops, mentionCtx)
    expect(result.action).toBe('drop')
  })

  test('DM allowlist delivers paired users', async () => {
    const ops = makeOps(baseAccess({ dmPolicy: 'allowlist', allowFrom: ['user-a'] }))
    const result = await gate(userPost('dm-1', 'user-a', 'hi'), 'D', ops, mentionCtx)
    expect(result.action).toBe('deliver')
  })

  test('group requireMention=false delivers unmentioned messages', async () => {
    const ops = makeOps(baseAccess({
      groups: { 'c': { requireMention: false, allowFrom: [] } },
    }))
    const result = await gate(userPost('c', 'u', 'no mention'), 'O', ops, mentionCtx)
    expect(result.action).toBe('deliver')
  })
})
