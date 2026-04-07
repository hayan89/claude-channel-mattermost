#!/usr/bin/env bun
/**
 * Lightweight trigger script executed by crontab.
 * Posts a scheduled prompt to Mattermost so the existing
 * server/router flow picks it up as a scheduled message.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  SCHEDULES_DIR,
  loadEnvFile,
  readSchedules,
  removeCrontabEntry,
} from './shared.js'

// Safety timeout: exit if stuck for 30 seconds
setTimeout(() => process.exit(1), 30_000)

// ── Argument parsing ──────────────────────────────────────────────────────

let scheduleId = ''
let channelId = ''
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--schedule-id' && i + 1 < process.argv.length) {
    scheduleId = process.argv[++i]
  } else if (process.argv[i] === '--channel-id' && i + 1 < process.argv.length) {
    channelId = process.argv[++i]
  }
}

if (!scheduleId || !channelId) {
  process.stderr.write('trigger: --schedule-id and --channel-id are required\n')
  process.exit(1)
}

// ── Log helper ────────────────────────────────────────────────────────────

const logPath = join(SCHEDULES_DIR, 'trigger.log')

function log(message: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${message}\n`
  try {
    appendFileSync(logPath, line)
    // Truncate if over 1MB: keep last 500 lines
    try {
      const st = statSync(logPath)
      if (st.size > 1_000_000) {
        const content = readFileSync(logPath, 'utf8')
        const lines = content.split('\n')
        writeFileSync(logPath, lines.slice(-500).join('\n'))
      }
    } catch {}
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────

loadEnvFile()

const url = process.env.MATTERMOST_URL
const token = process.env.MATTERMOST_TOKEN

if (!url || !token) {
  log(`ERROR schedule=${scheduleId} channel=${channelId}: MATTERMOST_URL or MATTERMOST_TOKEN not set`)
  process.exit(1)
}

// Look up the schedule
const schedules = readSchedules(channelId)
const entry = schedules.find(s => s.id === scheduleId)

if (!entry) {
  // Schedule was deleted — remove ourselves from crontab
  log(`CLEANUP schedule=${scheduleId} channel=${channelId}: schedule not found, removing crontab entry`)
  try { removeCrontabEntry(scheduleId) } catch {}
  process.exit(0)
}

// Post to Mattermost
try {
  const res = await fetch(`${url}/api/v4/posts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel_id: channelId,
      message: `[scheduled:${scheduleId}] ${entry.prompt}`,
    }),
  })

  if (res.ok) {
    log(`OK schedule=${scheduleId} channel=${channelId}: posted (status ${res.status})`)
    process.exit(0)
  } else {
    log(`ERROR schedule=${scheduleId} channel=${channelId}: HTTP ${res.status}`)
    process.exit(1)
  }
} catch (err) {
  log(`ERROR schedule=${scheduleId} channel=${channelId}: ${(err as Error).message}`)
  process.exit(1)
}
