#!/usr/bin/env bun
/**
 * Daily job scraper timer.
 * Runs the scraper at KST 09:00 and posts results to Mattermost.
 *
 * Usage:
 *   bun scraper/timer.ts              # Run as daemon (loops daily)
 *   bun scraper/timer.ts --once       # Run once and exit
 *   bun scraper/timer.ts --now        # Run immediately (no wait)
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";

const CHANNEL_ID = "rzktwhsx4pr3zyo1q9gmry9cky";
const TARGET_HOUR_KST = 9;
const TARGET_MINUTE = 0;
const SCRAPER_PATH = join(import.meta.dir, "run.ts");
const ENV_PATH = join(
  process.env.HOME || "/home/hyunseung",
  ".claude/channels/mattermost/.env"
);

// Load .env manually
function loadEnv(path: string) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

async function postToMattermost(text: string) {
  const url = process.env.MATTERMOST_URL;
  const token = process.env.MATTERMOST_TOKEN;
  if (!url || !token) throw new Error("MATTERMOST_URL or MATTERMOST_TOKEN not set");

  // Split long messages into chunks (Mattermost limit ~16383 chars)
  const MAX_LEN = 16000;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_LEN) {
    let splitAt = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);

  let firstPostId = "";
  for (const chunk of chunks) {
    const body: any = { channel_id: CHANNEL_ID, message: chunk };
    if (firstPostId) body.root_id = firstPostId;

    const res = await fetch(`${url}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      // Retry on 503
      if (res.status === 503) {
        console.log(`[timer] MM 503 — retrying in 60s...`);
        await Bun.sleep(60000);
        const retry = await fetch(`${url}/api/v4/posts`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (retry.ok) {
          if (!firstPostId) firstPostId = (await retry.json()).id;
          continue;
        }
      }
      throw new Error(`MM API ${res.status}: ${err}`);
    }

    if (!firstPostId) {
      const data = await res.json();
      firstPostId = data.id;
    }
  }
}

async function runScraper(): Promise<string> {
  console.log(`[timer] Running scraper: bun ${SCRAPER_PATH}`);
  const proc = Bun.spawn(["bun", SCRAPER_PATH], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (stderr) console.error(`[timer] Scraper stderr:\n${stderr}`);

  if (exitCode !== 0) {
    return `⚠️ 스크래퍼 실행 오류 (exit code ${exitCode})\n\n${stderr.slice(0, 500)}`;
  }

  return stdout || "⚠️ 스크래퍼가 빈 결과를 반환했습니다.";
}

async function execute() {
  try {
    const report = await runScraper();
    await postToMattermost(report);
    console.log(`[timer] Report posted to Mattermost`);
  } catch (e: any) {
    console.error(`[timer] Error: ${e.message}`);
    try {
      await postToMattermost(`⚠️ 이직 공고 스크래핑 오류: ${e.message}`);
    } catch {
      // ignore
    }
  }
}

// ── Main ──
const args = process.argv.slice(2);
loadEnv(ENV_PATH);

if (args.includes("--now") || args.includes("--once")) {
  await execute();
  if (args.includes("--once")) process.exit(0);
}

if (args.includes("--now") && !args.includes("--once")) {
  // Continue to daemon mode after immediate run
}

if (!args.includes("--once")) {
  console.log(`[timer] Daemon started. Trigger at KST ${TARGET_HOUR_KST}:00 daily.`);
  let lastTriggeredDate = "";

  while (true) {
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 3600000);
    const kstHour = kstNow.getUTCHours();
    const kstMinute = kstNow.getUTCMinutes();
    const kstDate = kstNow.toISOString().slice(0, 10);

    if (
      kstHour === TARGET_HOUR_KST &&
      kstMinute >= TARGET_MINUTE &&
      kstMinute < TARGET_MINUTE + 5 &&
      kstDate !== lastTriggeredDate
    ) {
      lastTriggeredDate = kstDate;
      console.log(`[timer] Trigger at ${kstDate} KST ${kstHour}:${String(kstMinute).padStart(2, "0")}`);
      await execute();
    }

    // Sleep 60 seconds
    await Bun.sleep(60000);
  }
}
