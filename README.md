# claude-channel-mattermost

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.0-f9f1e1.svg)](https://bun.sh)

An MCP server that connects Mattermost to Claude Code — send and receive messages, manage files, and control access through a bot account.

Mattermost 봇 계정을 통해 Claude Code와 메시지를 주고받을 수 있는 MCP 서버입니다. 접근 제어, 파일 관리, 플랜 모드 등을 지원합니다.

## Features / 주요 기능

- **Messaging bridge** — forward Mattermost DMs and channel messages to Claude Code, reply back with auto-chunking and threading
  (Mattermost DM 및 채널 메시지를 Claude Code로 전달, 자동 분할 및 스레딩으로 응답)
- **5 built-in tools** — reply, react, edit, fetch history, download attachments
  (답장, 리액션, 수정, 히스토리 조회, 첨부파일 다운로드 도구 내장)
- **Multi-layer access control** — pairing codes, allowlists, per-channel gating, and static mode
  (페어링 코드, 허용 목록, 채널별 접근 제어, 정적 모드 등 다층 보안)
- **Plan mode** — `!plan` / `!go` / `!cancel` workflow for review-before-execute
  (실행 전 검토를 위한 플랜 모드)
- **Per-chat notes** — channel-scoped context persistence across sessions
  (채널별 메모로 세션 간 컨텍스트 유지)
- **Zero build step** — runs directly with Bun, single TypeScript file
  (빌드 없이 Bun으로 바로 실행, 단일 TypeScript 파일)

## Prerequisites / 사전 요구사항

- [Bun](https://bun.sh) >= 1.0: `curl -fsSL https://bun.sh/install | bash`
- Mattermost 서버 (self-hosted 또는 cloud) with bot account support enabled

## Quick Start / 빠른 시작

### 1. Create a bot account / 봇 계정 생성

System Console → Integrations → Bot Accounts → **Enable Bot Account Creation**.
Then: Integrations → Bot Accounts → **Add Bot Account**. Give it a username (e.g. `claude-bot`).

### 2. Generate a token / 토큰 생성

After creating the bot, copy the **Access Token** — it's only shown once.
봇 생성 후 **Access Token**을 복사하세요 — 한 번만 표시됩니다.

### 3. Invite the bot / 봇 초대

In channels where you want the bot to respond:
```
/invite @claude-bot
```

### 4. Install the plugin / 플러그인 설치

```
/plugin install mattermost@claude-plugins-official
```

### 5. Configure credentials / 인증 정보 설정

```
/mattermost:configure https://your.mattermost.server.com xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

This writes `MATTERMOST_URL` and `MATTERMOST_TOKEN` to `~/.claude/channels/mattermost/.env`.
You can also set environment variables directly (shell env takes precedence).

**Multiple instances:** set `MATTERMOST_STATE_DIR` to a different directory per instance.

### 6. Launch / 실행

```sh
claude --channels plugin:mattermost@claude-plugins-official
```

### 7. Pair / 페어링

DM the bot on Mattermost. It replies with a 6-character code. In Claude Code:
```
/mattermost:access pair <code>
```

### 8. Lock it down / 잠금 설정

Once everyone who needs access is paired, switch to allowlist mode:
모든 사용자가 페어링되면 allowlist 모드로 전환하세요:

```
/mattermost:access policy allowlist
```

## Tools / 도구

| Tool | Description |
|------|-------------|
| `reply` | Send message to a channel. Supports `reply_to`/`thread_id` for threading, `files` for attachments (max 10, 50MB each). Auto-chunks at 16383 chars. |
| `react` | Add emoji reaction by message ID. Use short names without colons: `thumbsup` not `:thumbsup:`. |
| `edit_message` | Edit a message the bot previously sent. Bot's own messages only. |
| `fetch_messages` | Pull recent history (oldest-first, max 200/call). Includes message IDs and attachment markers. |
| `download_attachment` | Download attachments from a message to `~/.claude/channels/mattermost/inbox/`. Returns paths + metadata. |

Inbound messages trigger a typing indicator automatically.

## Access Control / 접근 제어

### DM Policies / DM 정책

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Reply with a 6-char code, drop the message. Approve with `/mattermost:access pair <code>`. |
| `allowlist` | Drop silently. For when everyone who needs access is already listed. |
| `disabled` | Drop everything, including allowlisted senders and group channels. |

### Group Channels / 그룹 채널

Off by default. Opt in per channel ID:
```
/mattermost:access group add <channelId>
```

With `requireMention: true` (default), the bot only responds when mentioned or replied to.

### Mention Detection / 멘션 감지

1. Plain text `@botname` in the message
2. Thread reply to a recent bot message (last 200 tracked)
3. Custom regex via `mentionPatterns`

### Skill Commands / 스킬 명령어

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

## Configuration / 설정

### Environment Variables / 환경 변수

| Variable | Description |
|----------|-------------|
| `MATTERMOST_URL` | Mattermost server URL |
| `MATTERMOST_TOKEN` | Bot access token |
| `MATTERMOST_STATE_DIR` | Custom state directory (default: `~/.claude/channels/mattermost/`) |
| `MATTERMOST_ACCESS_MODE` | Set to `static` to pin config at boot (no pairing, no writes) |

### Delivery Config / 전달 설정

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ackReaction` | string | *(none)* | Emoji short name to react on receipt (e.g. `eyes`) |
| `replyToMode` | string | `first` | Threading on chunked replies: `first`, `all`, or `off` |
| `textChunkLimit` | number | `16383` | Max characters per message before splitting |
| `chunkMode` | string | `length` | `length` = hard cut; `newline` = prefer paragraph boundaries |
| `mentionPatterns` | array | `[]` | Case-insensitive regex strings for mention detection |

### Config File Example / 설정 파일 예시

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

## Plan Mode / 플랜 모드

Ask Claude to plan before executing:
실행 전에 Claude에게 계획을 요청할 수 있습니다:

```
!plan add a health check endpoint to the API
```

Claude will research and present a plan without making changes. Then:
Claude가 변경 없이 계획을 제시합니다. 이후:

- `!go` — approve and execute / 승인 후 실행
- `!go but skip the tests` — approve with additional context / 추가 지시와 함께 승인
- `!cancel` — cancel without executing / 실행 없이 취소

Plan mode persists until `!go` or `!cancel`. Regular messages continue the planning conversation.

## Self-Hosted Notes / 자체 호스팅 참고사항

- The bot needs `post:all` and `post:channels` permissions (or system admin)
- WebSocket connects to `wss://your.server.com/api/v4/websocket`
- File downloads require authentication headers (handled automatically)
- Default max post size is 16383 characters (configurable per server)

## Security / 보안

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

### Reporting Vulnerabilities / 취약점 신고

**Do not file a public issue.** Report through [GitHub Security Advisories](https://github.com/hayan89/claude-channel-mattermost/security/advisories/new).
공개 이슈로 등록하지 마세요. GitHub Security Advisories를 통해 신고해 주세요.

## Contributing / 기여

The server is a single TypeScript file (`server.ts`) running on Bun with one dependency (`@modelcontextprotocol/sdk`).

```sh
git clone https://github.com/hayan89/claude-channel-mattermost.git
cd claude-channel-mattermost
bun install
bun run typecheck
```

**Code style:** 2-space indent, single quotes, no semicolons.

PRs welcome — keep changes focused, run `bun run typecheck`, and describe your manual testing steps.

## License / 라이선스

[Apache License 2.0](LICENSE)

Copyright 2025 hyunseung
