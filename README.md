# claude-channel-mattermost

[한국어](README.ko.md) | **English**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.0-f9f1e1.svg)](https://bun.sh)

An MCP server that connects Mattermost to Claude Code — send and receive messages, manage files, and control access through a bot account.

## Features

- **Messaging bridge** — forward Mattermost DMs and channel messages to Claude Code, reply back with auto-chunking and threading
- **5 built-in tools** — reply, react, edit, fetch history, download attachments
- **Multi-layer access control** — pairing codes, allowlists, per-channel gating, and static mode
- **Plan mode** — `!plan` / `!go` / `!cancel` workflow for review-before-execute
- **Per-chat notes** — channel-scoped context persistence across sessions
- **Zero build step** — runs directly with Bun, single TypeScript file

## Prerequisites

- [Bun](https://bun.sh) >= 1.0: `curl -fsSL https://bun.sh/install | bash`
- Mattermost server (self-hosted or cloud) with bot account support enabled

## Quick Start

### 1. Create a bot account

System Console → Integrations → Bot Accounts → **Enable Bot Account Creation**.
Then: Integrations → Bot Accounts → **Add Bot Account**. Give it a username (e.g. `claude-bot`).

### 2. Generate a token

After creating the bot, copy the **Access Token** — it's only shown once.

### 3. Invite the bot

In channels where you want the bot to respond:
```
/invite @claude-bot
```

### 4. Install the plugin

```
/plugin install mattermost@claude-plugins-official
```

### 5. Configure credentials

```
/mattermost:configure https://your.mattermost.server.com xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

This writes `MATTERMOST_URL` and `MATTERMOST_TOKEN` to `~/.claude/channels/mattermost/.env`.
You can also set environment variables directly (shell env takes precedence).

**Multiple instances:** set `MATTERMOST_STATE_DIR` to a different directory per instance.

### 6. Launch

```sh
claude --channels plugin:mattermost@claude-plugins-official
```

### 7. Pair

DM the bot on Mattermost. It replies with a 6-character code. In Claude Code:
```
/mattermost:access pair <code>
```

### 8. Lock it down

Once everyone who needs access is paired, switch to allowlist mode:

```
/mattermost:access policy allowlist
```

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send message to a channel. Supports `reply_to`/`thread_id` for threading, `files` for attachments (max 10, 50MB each). Auto-chunks at 16383 chars. |
| `react` | Add emoji reaction by message ID. Use short names without colons: `thumbsup` not `:thumbsup:`. |
| `edit_message` | Edit a message the bot previously sent. Bot's own messages only. |
| `fetch_messages` | Pull recent history (oldest-first, max 200/call). Includes message IDs and attachment markers. |
| `download_attachment` | Download attachments from a message to `~/.claude/channels/mattermost/inbox/`. Returns paths + metadata. |

Inbound messages trigger a typing indicator automatically.

## Access Control

### DM Policies

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Reply with a 6-char code, drop the message. Approve with `/mattermost:access pair <code>`. |
| `allowlist` | Drop silently. For when everyone who needs access is already listed. |
| `disabled` | Drop everything, including allowlisted senders and group channels. |

### Group Channels

Off by default. Opt in per channel ID:
```
/mattermost:access group add <channelId>
```

With `requireMention: true` (default), the bot only responds when mentioned or replied to.

### Mention Detection

1. Plain text `@botname` in the message
2. Thread reply to a recent bot message (last 200 tracked)
3. Custom regex via `mentionPatterns`

### Skill Commands

| Command | Effect |
|---------|--------|
| `/mattermost:access` | Show current state |
| `/mattermost:access pair <code>` | Approve pairing code |
| `/mattermost:access deny <code>` | Discard pending code |
| `/mattermost:access allow <userId>` | Add to allowlist |
| `/mattermost:access remove <userId>` | Remove from allowlist |
| `/mattermost:access policy <name>` | Set DM policy |
| `/mattermost:access group add <id>` | Enable group channel |
| `/mattermost:access group rm <id>` | Disable group channel |
| `/mattermost:access set <key> <val>` | Set delivery config |

**User IDs:** Mattermost alphanumeric strings. Find via profile popover → three-dot menu → Copy ID.

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MATTERMOST_URL` | Mattermost server URL |
| `MATTERMOST_TOKEN` | Bot access token |
| `MATTERMOST_STATE_DIR` | Custom state directory (default: `~/.claude/channels/mattermost/`) |
| `MATTERMOST_ACCESS_MODE` | Set to `static` to pin config at boot (no pairing, no writes) |

### Delivery Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ackReaction` | string | *(none)* | Emoji short name to react on receipt (e.g. `eyes`) |
| `replyToMode` | string | `first` | Threading on chunked replies: `first`, `all`, or `off` |
| `textChunkLimit` | number | `16383` | Max characters per message before splitting |
| `chunkMode` | string | `length` | `length` = hard cut; `newline` = prefer paragraph boundaries |
| `mentionPatterns` | array | `[]` | Case-insensitive regex strings for mention detection |

### Config File Example

```jsonc
// ~/.claude/channels/mattermost/access.json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["abc123def456ghi789jklmno"],
  "groups": {
    "xyz789abc123def456ghi789": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "mentionPatterns": ["^hey claude\\b"],
  "ackReaction": "eyes",
  "replyToMode": "first",
  "textChunkLimit": 16383,
  "chunkMode": "newline"
}
```

## Plan Mode

Ask Claude to plan before executing:

```
!plan add a health check endpoint to the API
```

Claude will research and present a plan without making changes. Then:

- `!go` — approve and execute
- `!go but skip the tests` — approve with additional context
- `!cancel` — cancel without executing

Plan mode persists until `!go` or `!cancel`. Regular messages continue the planning conversation.

## Self-Hosted Notes

- The bot needs `post:all` and `post:channels` permissions (or system admin)
- WebSocket connects to `wss://your.server.com/api/v4/websocket`
- File downloads require authentication headers (handled automatically)
- Default max post size is 16383 characters (configurable per server)

## Security

This project implements multiple layers of defense:

| Mechanism | Description |
|-----------|-------------|
| DM policies | `pairing`, `allowlist`, `disabled` — all inbound DMs pass through `gate()` |
| Pairing limits | Max 3 pending codes, 1-hour expiry, 6-char hex |
| `assertSendable()` | Blocks sending files outside the inbox directory |
| `assertAllowedChannel()` | Validates outbound replies target allowed channels |
| Skill refusal | `/mattermost:access` refuses mutations from channel messages |
| Static mode | `MATTERMOST_ACCESS_MODE=static` pins config at boot |
| Atomic writes | State files use temp-file + rename to prevent corruption |
| File permissions | Sensitive files are `chmod 0o600` |

### Reporting Vulnerabilities

**Do not file a public issue.** Report through [GitHub Security Advisories](https://github.com/hayan89/claude-channel-mattermost/security/advisories/new).

## Contributing

The server is a single TypeScript file (`server.ts`) running on Bun with one dependency (`@modelcontextprotocol/sdk`).

```sh
git clone https://github.com/hayan89/claude-channel-mattermost.git
cd claude-channel-mattermost
bun install
bun run typecheck
```

**Code style:** 2-space indent, single quotes, no semicolons.

PRs welcome — keep changes focused, run `bun run typecheck`, and describe your manual testing steps.

## License

[Apache License 2.0](LICENSE)

Copyright 2025 hyunseung
