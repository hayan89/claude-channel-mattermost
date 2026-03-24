# claude-channel-mattermost

**한국어** | [English](README.md)

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.0-f9f1e1.svg)](https://bun.sh)

Mattermost 봇 계정을 통해 Claude Code와 메시지를 주고받을 수 있는 MCP 서버입니다. 접근 제어, 파일 관리, 플랜 모드 등을 지원합니다.

## 주요 기능

- **메시징 브리지** — Mattermost DM 및 채널 메시지를 Claude Code로 전달, 자동 분할 및 스레딩으로 응답
- **5가지 내장 도구** — 답장, 리액션, 수정, 히스토리 조회, 첨부파일 다운로드
- **다층 접근 제어** — 페어링 코드, 허용 목록, 채널별 접근 제어, 정적 모드
- **플랜 모드** — `!plan` / `!go` / `!cancel` 워크플로우로 실행 전 검토
- **채널별 메모** — 채널 단위 컨텍스트를 세션 간 유지
- **빌드 불필요** — Bun으로 바로 실행, 단일 TypeScript 파일

## 사전 요구사항

- [Bun](https://bun.sh) >= 1.0: `curl -fsSL https://bun.sh/install | bash`
- Mattermost 서버 (self-hosted 또는 cloud), 봇 계정 지원 활성화 필요

## 빠른 시작

### 1. 봇 계정 생성

System Console → Integrations → Bot Accounts → **Enable Bot Account Creation** 활성화.
이후 Integrations → Bot Accounts → **Add Bot Account**에서 사용자 이름을 지정합니다 (예: `claude-bot`).

### 2. 토큰 생성

봇 생성 후 **Access Token**을 복사하세요 — 한 번만 표시됩니다.

### 3. 봇 초대

봇이 응답할 채널에서:
```
/invite @claude-bot
```

### 4. 플러그인 설치

```
/plugin install mattermost@claude-plugins-official
```

### 5. 인증 정보 설정

```
/mattermost:configure https://your.mattermost.server.com xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`MATTERMOST_URL`과 `MATTERMOST_TOKEN`이 `~/.claude/channels/mattermost/.env`에 저장됩니다.
환경 변수를 직접 설정할 수도 있습니다 (쉘 환경 변수가 우선).

**다중 인스턴스:** 인스턴스별로 `MATTERMOST_STATE_DIR`을 다른 디렉토리로 설정하세요.

### 6. 실행

```sh
claude --channels plugin:mattermost@claude-plugins-official
```

### 7. 페어링

Mattermost에서 봇에게 DM을 보내면 6자리 코드로 응답합니다. Claude Code에서:
```
/mattermost:access pair <code>
```

### 8. 잠금 설정

모든 사용자가 페어링되면 allowlist 모드로 전환하세요:

```
/mattermost:access policy allowlist
```

## 도구

| 도구 | 설명 |
|------|------|
| `reply` | 채널에 메시지 전송. 스레딩을 위한 `reply_to`/`thread_id`, 첨부를 위한 `files` 지원 (최대 10개, 각 50MB). 16383자 초과 시 자동 분할. |
| `react` | 메시지 ID로 이모지 리액션 추가. 콜론 없이 짧은 이름 사용: `:thumbsup:` 대신 `thumbsup`. |
| `edit_message` | 봇이 이전에 보낸 메시지 수정. 봇 자신의 메시지만 가능. |
| `fetch_messages` | 최근 히스토리 조회 (오래된 순, 호출당 최대 200개). 메시지 ID 및 첨부파일 마커 포함. |
| `download_attachment` | 메시지의 첨부파일을 `~/.claude/channels/mattermost/inbox/`에 다운로드. 경로 및 메타데이터 반환. |

수신 메시지는 자동으로 타이핑 인디케이터를 트리거합니다.

## 접근 제어

### DM 정책

| 정책 | 동작 |
|------|------|
| `pairing` (기본값) | 6자리 코드로 응답하고 메시지를 드롭. `/mattermost:access pair <code>`로 승인. |
| `allowlist` | 조용히 드롭. 접근이 필요한 모든 사용자가 이미 등록된 경우. |
| `disabled` | 허용 목록 발신자와 그룹 채널 포함 모든 것을 드롭. |

### 그룹 채널

기본적으로 비활성화. 채널 ID별로 활성화:
```
/mattermost:access group add <channelId>
```

`requireMention: true` (기본값)일 때 봇은 멘션되거나 답장받을 때만 응답합니다.

### 멘션 감지

1. 메시지 내 `@botname` 텍스트
2. 최근 봇 메시지에 대한 스레드 답장 (최근 200개 추적)
3. `mentionPatterns`를 통한 커스텀 정규식

### 스킬 명령어

| 명령어 | 효과 |
|--------|------|
| `/mattermost:access` | 현재 상태 표시 |
| `/mattermost:access pair <code>` | 페어링 코드 승인 |
| `/mattermost:access deny <code>` | 대기 중인 코드 폐기 |
| `/mattermost:access allow <userId>` | 허용 목록에 추가 |
| `/mattermost:access remove <userId>` | 허용 목록에서 제거 |
| `/mattermost:access policy <name>` | DM 정책 설정 |
| `/mattermost:access group add <id>` | 그룹 채널 활성화 |
| `/mattermost:access group rm <id>` | 그룹 채널 비활성화 |
| `/mattermost:access set <key> <val>` | 전달 설정 변경 |

**사용자 ID:** Mattermost 영숫자 문자열. 프로필 팝오버 → 점 세 개 메뉴 → Copy ID에서 확인.

## 설정

### 환경 변수

| 변수 | 설명 |
|------|------|
| `MATTERMOST_URL` | Mattermost 서버 URL |
| `MATTERMOST_TOKEN` | 봇 액세스 토큰 |
| `MATTERMOST_STATE_DIR` | 커스텀 상태 디렉토리 (기본값: `~/.claude/channels/mattermost/`) |
| `MATTERMOST_ACCESS_MODE` | `static`으로 설정하면 부팅 시 설정 고정 (페어링 없음, 쓰기 없음) |

### 전달 설정

| 키 | 타입 | 기본값 | 설명 |
|----|------|--------|------|
| `ackReaction` | string | *(없음)* | 수신 시 리액션할 이모지 짧은 이름 (예: `eyes`) |
| `replyToMode` | string | `first` | 분할 응답 시 스레딩: `first`, `all`, 또는 `off` |
| `textChunkLimit` | number | `16383` | 분할 전 메시지당 최대 문자 수 |
| `chunkMode` | string | `length` | `length` = 강제 분할; `newline` = 문단 경계 우선 |
| `mentionPatterns` | array | `[]` | 대소문자 무시 멘션 감지 정규식 문자열 |

### 설정 파일 예시

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

## 플랜 모드

실행 전에 Claude에게 계획을 요청할 수 있습니다:

```
!plan API에 헬스체크 엔드포인트 추가
```

Claude가 변경 없이 계획을 제시합니다. 이후:

- `!go` — 승인 후 실행
- `!go 테스트는 생략` — 추가 지시와 함께 승인
- `!cancel` — 실행 없이 취소

`!go` 또는 `!cancel` 전까지 플랜 모드가 유지됩니다. 일반 메시지는 계획 대화를 계속합니다.

## 자체 호스팅 참고사항

- 봇에 `post:all` 및 `post:channels` 권한 필요 (또는 시스템 관리자)
- WebSocket은 `wss://your.server.com/api/v4/websocket`에 연결
- 파일 다운로드에 인증 헤더 필요 (자동 처리)
- 기본 최대 게시글 크기는 16383자 (서버별 설정 가능)

## 보안

이 프로젝트는 다층 방어를 구현합니다:

| 메커니즘 | 설명 |
|----------|------|
| DM 정책 | `pairing`, `allowlist`, `disabled` — 모든 수신 DM은 `gate()`를 통과 |
| 페어링 제한 | 최대 3개 대기 코드, 1시간 만료, 6자리 hex |
| `assertSendable()` | inbox 디렉토리 외부 파일 전송 차단 |
| `assertAllowedChannel()` | 발신 응답이 허용된 채널을 대상으로 하는지 검증 |
| 스킬 거부 | `/mattermost:access`가 채널 메시지에서의 변경을 거부 |
| 정적 모드 | `MATTERMOST_ACCESS_MODE=static`으로 부팅 시 설정 고정 |
| 원자적 쓰기 | 상태 파일은 임시 파일 + 이름 변경으로 손상 방지 |
| 파일 권한 | 민감한 파일은 `chmod 0o600` |

### 취약점 신고

**공개 이슈로 등록하지 마세요.** [GitHub Security Advisories](https://github.com/hayan89/claude-channel-mattermost/security/advisories/new)를 통해 신고해 주세요.

## 기여

서버는 하나의 의존성(`@modelcontextprotocol/sdk`)만 사용하는 단일 TypeScript 파일(`server.ts`)로, Bun에서 실행됩니다.

```sh
git clone https://github.com/hayan89/claude-channel-mattermost.git
cd claude-channel-mattermost
bun install
bun run typecheck
```

**코드 스타일:** 2칸 들여쓰기, 작은따옴표, 세미콜론 없음.

PR 환영합니다 — 변경사항은 집중적으로, `bun run typecheck` 실행 후, 수동 테스트 단계를 설명해 주세요.

## 라이선스

[Apache License 2.0](LICENSE)

Copyright 2025 hyunseung
