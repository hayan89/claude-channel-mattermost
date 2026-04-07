# 스케줄링 기능 설계 (Schedule Feature Design)

## Context

현재 Claude Channel Mattermost는 사용자가 메시지를 보낼 때만 Claude가 응답한다.
사용자가 반복적으로 요청하는 작업(매일 할일 정리, 주간 리포트, 정기 모니터링 등)을 cron 스케줄로 자동화하여,
지정된 시간에 Claude가 프롬프트를 자동 실행하고 결과를 채널에 포스팅하는 기능을 추가한다.

## 결정 사항

| 항목 | 결정 |
|------|------|
| 등록 방식 | Mattermost 채팅에서 자연어로 요청 → Claude가 MCP tool 호출 |
| 트리거 동작 | 프롬프트를 Claude에 전달, 결과는 채널에 포스팅 |
| cron 구현 | 시스템 crontab 활용 (프로세스 독립적) |
| 스케줄 범위 | 채널별 바인딩 |
| 시간 지정 | 자연어 + cron 표현식 둘 다 지원 (Claude가 자연어 → cron 변환) |
| 세션 부재 시 | Mattermost API로 봇이 채널에 포스팅 → 기존 흐름 탑승 |
| 트리거 구분 | `[scheduled:ID]` 특수 프리픽스로 봇 메시지 필터 우회 |

## 아키텍처

```
사용자: "매일 9시에 할일 정리해줘"
        ↓
Claude: 자연어 해석 → schedule_create tool 호출 (cron: "0 9 * * *", prompt: "오늘 할 일을 정리해줘")
        ↓
server.ts: schedules/{channelId}.json에 저장 + crontab에 엔트리 등록
        ↓
[매일 9시] crontab → trigger.ts 실행
        ↓
trigger.ts: Mattermost REST API로 봇이 채널에 포스팅
            "[scheduled:sch_abc123] 오늘 할 일을 정리해줘"
        ↓
서버/라우터: 봇 메시지지만 [scheduled:*] 프리픽스 감지 → 프리픽스 제거 후 Claude에 전달
             컨텍스트 주입: "[이 메시지는 예약된 스케줄(매일 오전 9시)에 의해 자동 실행되었습니다]"
        ↓
Claude: 프롬프트 처리 → reply tool로 결과를 같은 채널에 포스팅
```

## MCP Tools

### schedule_create

```typescript
{
  name: "schedule_create",
  description: "채널에 반복 실행할 스케줄을 등록합니다. cron 표현식과 실행할 프롬프트를 받습니다.",
  inputSchema: {
    type: "object",
    properties: {
      cron: { type: "string", description: "cron 표현식 (예: '0 9 * * *')" },
      prompt: { type: "string", description: "실행할 프롬프트" },
      description: { type: "string", description: "사용자 친화적 설명 (예: '매일 오전 9시')" }
    },
    required: ["cron", "prompt"]
  }
}
```

동작:
1. 스케줄 ID 생성 (`sch_` + 랜덤 8자)
2. `schedules/{channelId}.json`에 엔트리 추가 (atomic write)
3. crontab에 엔트리 등록
4. 반환: 생성된 스케줄 정보 + 다음 실행 시각

### schedule_list

```typescript
{
  name: "schedule_list",
  description: "현재 채널에 등록된 모든 스케줄 목록을 조회합니다.",
  inputSchema: { type: "object", properties: {} }
}
```

### schedule_delete

```typescript
{
  name: "schedule_delete",
  description: "스케줄을 삭제합니다.",
  inputSchema: {
    type: "object",
    properties: {
      scheduleId: { type: "string", description: "삭제할 스케줄 ID" }
    },
    required: ["scheduleId"]
  }
}
```

동작:
1. `schedules/{channelId}.json`에서 해당 엔트리 제거
2. crontab에서 해당 엔트리 제거
3. 반환: 삭제 확인

## 상태 파일

### schedules/{channelId}.json

```json
{
  "schedules": [
    {
      "id": "sch_abc12345",
      "cron": "0 9 * * *",
      "prompt": "오늘 할 일을 정리해줘",
      "description": "매일 오전 9시",
      "createdBy": "user123",
      "createdAt": "2026-04-07T10:00:00Z"
    }
  ]
}
```

저장 위치: `~/.claude/channels/mattermost/schedules/`
기존 atomic write 패턴 사용 (tmp → chmod 0o600 → rename)

## trigger.ts (신규 파일)

crontab이 실행하는 경량 독립 스크립트.

```
#!/usr/bin/env bun
인자: --schedule-id <id> --channel-id <channelId>

1. shared.ts에서 loadEnvFile()로 .env 로드 (MATTERMOST_URL, MATTERMOST_TOKEN)
2. schedules/{channelId}.json에서 해당 스케줄 조회
3. 스케줄이 없으면 (삭제됨) → crontab에서 자기 자신 제거 후 종료
4. Mattermost REST API로 포스팅:
   POST /api/v4/posts
   { channel_id, message: "[scheduled:sch_abc12345] 오늘 할 일을 정리해줘" }
5. 성공/실패를 schedules/trigger.log에 기록
```

## 봇 메시지 필터 수정

### server.ts (WebSocket 핸들러)

기존: `if (post.user_id === botUserId) return` → 봇 자신의 메시지 무시

수정:
```
if (post.user_id === botUserId) {
  const scheduledMatch = post.message.match(/^\[scheduled:(sch_\w+)\]\s*/)
  if (!scheduledMatch) return  // 일반 봇 메시지는 기존대로 무시

  // 스케줄 트리거 메시지 처리
  const scheduleId = scheduledMatch[1]
  const actualPrompt = post.message.replace(scheduledMatch[0], '')
  // scheduleId로 스케줄 정보 조회하여 컨텍스트 주입 후 Claude에 전달
}
```

### router.ts (동일한 수정)

라우터의 WebSocket 핸들러에도 같은 로직 적용.

## crontab 관리

### 등록 (shared.ts 유틸)

```typescript
function addCrontabEntry(scheduleId: string, channelId: string, cron: string): void {
  // 1. crontab -l로 현재 엔트리 읽기
  // 2. bun 경로는 which bun 또는 process.argv[0]에서 절대 경로 획득
  // 3. 태그 주석 + 엔트리 추가
  //    # claude-channel-mattermost:{scheduleId}
  //    0 9 * * * /absolute/path/to/bun /absolute/path/to/trigger.ts --schedule-id {scheduleId} --channel-id {channelId}
  // 4. crontab -로 전체 교체 (pipe)
}
```

### 삭제 (shared.ts 유틸)

```typescript
function removeCrontabEntry(scheduleId: string): void {
  // 1. crontab -l로 현재 엔트리 읽기
  // 2. # claude-channel-mattermost:{scheduleId} 태그가 붙은 라인 + 다음 라인 제거
  // 3. crontab -로 전체 교체
}
```

### 전체 조회

```typescript
function listCrontabEntries(): string[] {
  // crontab -l | grep "claude-channel-mattermost:" 로 필터링
}
```

## 보안 및 제한

- **권한**: 기존 access gate를 통과한 사용자만 스케줄 등록 가능
- **채널 격리**: 스케줄은 등록된 채널에만 바인딩, 다른 채널의 스케줄 조작 불가
- **최대 스케줄 수**: 채널당 20개 상한
- **crontab 격리**: `# claude-channel-mattermost:` 주석 태그로 다른 crontab 엔트리와 충돌 방지
- **자기 정리**: trigger.ts 실행 시 해당 스케줄이 삭제되어 있으면 crontab에서 자기 자신을 제거

## 수정 대상 파일

| 파일 | 변경 내용 |
|------|----------|
| `server.ts` | schedule_create/list/delete MCP tool 3개 추가 + 봇 메시지 필터에 스케줄 예외 추가 |
| `router.ts` | 봇 메시지 필터에 스케줄 예외 추가 |
| `shared.ts` | Schedule 타입 정의, crontab 관리 유틸(add/remove/list), 스케줄 파일 읽기/쓰기 |
| `trigger.ts` (신규) | crontab이 실행하는 경량 트리거 스크립트 |

## 검증 방법

1. **단위 테스트**: crontab 파싱/생성 유틸 함수 테스트
2. **통합 테스트**:
   - schedule_create → crontab에 엔트리가 등록되는지 확인 (`crontab -l`)
   - trigger.ts 직접 실행 → Mattermost 채널에 메시지가 포스팅되는지 확인
   - 포스팅된 메시지가 서버/라우터에서 스케줄 트리거로 인식되어 Claude에 전달되는지 확인
   - schedule_delete → crontab에서 엔트리가 제거되는지 확인
3. **E2E 테스트**: 짧은 간격(매분)의 스케줄을 등록하고 실제로 Claude가 응답하는지 확인
