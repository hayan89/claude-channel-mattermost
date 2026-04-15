#!/usr/bin/env bun
/**
 * Job Scraper - Daily job posting scraper for Mattermost channel
 *
 * Usage:
 *   bun scraper/run.ts                  # Use today's rotated keywords
 *   bun scraper/run.ts --keywords "백엔드 개발자" "Java 개발자"
 *   bun scraper/run.ts --test           # Quick test with first keyword set
 *   bun scraper/run.ts --source wanted  # Test single source
 */

import { chromium } from "playwright";
import { getTodayKeywords, DATA_DIR, SEEN_FILE, PROFILE } from "./config";
import { scrapeWanted } from "./wanted";
import { scrapeJobKorea } from "./jobkorea";
import { scrapeSaramin } from "./saramin";
import { scrapeJumpit } from "./jumpit";
import { scoreJob, deduplicateJobs, sortJobs } from "./matcher";
import { formatReport } from "./formatter";
import type { JobListing } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ------- CLI args -------
const args = process.argv.slice(2);
const isTest = args.includes("--test");
const sourceOnly = args.includes("--source")
  ? args[args.indexOf("--source") + 1]
  : null;

let keywords: string[];
const kwIdx = args.indexOf("--keywords");
if (kwIdx >= 0) {
  keywords = args.slice(kwIdx + 1).filter((a) => !a.startsWith("--"));
} else if (isTest) {
  keywords = ["백엔드 개발자"];
} else {
  keywords = getTodayKeywords();
}

// ------- Seen jobs tracking -------
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let seenUrls: Set<string>;
try {
  const data = readFileSync(SEEN_FILE, "utf-8");
  seenUrls = new Set(JSON.parse(data));
} catch {
  seenUrls = new Set();
}

// ------- Main -------
async function main() {
  console.error(
    `[scraper] Starting with keywords: ${keywords.join(", ")}${sourceOnly ? ` (source: ${sourceOnly})` : ""}`
  );
  const startTime = Date.now();

  const allJobs: JobListing[] = [];
  const allErrors: string[] = [];

  // Launch shared browser for Playwright-based scrapers
  let browser;
  const needsBrowser =
    !sourceOnly ||
    ["jobkorea", "saramin", "jumpit"].includes(sourceOnly);

  if (needsBrowser) {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (e: any) {
      allErrors.push(`Browser launch failed: ${e.message}`);
    }
  }

  // Run scrapers (with concurrency where possible)
  const tasks: Promise<void>[] = [];

  if (!sourceOnly || sourceOnly === "wanted") {
    tasks.push(
      scrapeWanted(keywords)
        .then((r) => {
          allJobs.push(...r.jobs);
          allErrors.push(...r.errors);
          console.error(`[scraper] Wanted: ${r.jobs.length} jobs`);
        })
        .catch((e) => allErrors.push(`Wanted fatal: ${e.message}`))
    );
  }

  if ((!sourceOnly || sourceOnly === "jumpit") && browser) {
    tasks.push(
      scrapeJumpit(keywords, browser)
        .then((r) => {
          allJobs.push(...r.jobs);
          allErrors.push(...r.errors);
          console.error(`[scraper] Jumpit: ${r.jobs.length} jobs`);
        })
        .catch((e) => allErrors.push(`Jumpit fatal: ${e.message}`))
    );
  }

  if ((!sourceOnly || sourceOnly === "jobkorea") && browser) {
    tasks.push(
      scrapeJobKorea(keywords, browser)
        .then((r) => {
          allJobs.push(...r.jobs);
          allErrors.push(...r.errors);
          console.error(`[scraper] JobKorea: ${r.jobs.length} jobs`);
        })
        .catch((e) => allErrors.push(`JobKorea fatal: ${e.message}`))
    );
  }

  // Saramin is currently blocked by anti-bot measures.
  // TODO: Re-enable when stealth mode is implemented.
  if (sourceOnly === "saramin" && browser) {
    tasks.push(
      scrapeSaramin(keywords, browser)
        .then((r) => {
          allJobs.push(...r.jobs);
          allErrors.push(...r.errors);
          console.error(`[scraper] Saramin: ${r.jobs.length} jobs`);
        })
        .catch((e) => allErrors.push(`Saramin fatal: ${e.message}`))
    );
  }

  await Promise.all(tasks);

  if (browser) await browser.close();

  // Score all jobs
  for (const job of allJobs) {
    scoreJob(job);
  }

  // Filter out current company
  const excludeCompany = PROFILE.currentCompany;
  if (excludeCompany) {
    const before = allJobs.length;
    const filtered = allJobs.filter(
      (j) => !j.company.includes(excludeCompany)
    );
    const removed = before - filtered.length;
    if (removed > 0) {
      console.error(`[scraper] Excluded ${removed} jobs from ${excludeCompany}`);
    }
    allJobs.length = 0;
    allJobs.push(...filtered);
  }

  // Filter out previously seen (unless test mode)
  let newJobs: JobListing[];
  if (isTest) {
    newJobs = allJobs;
  } else {
    newJobs = allJobs.filter((j) => !seenUrls.has(j.url));
  }

  // Deduplicate
  newJobs = deduplicateJobs(newJobs);

  // Sort: large companies first, then by match score
  newJobs = sortJobs(newJobs);

  // Generate report
  const report = formatReport(newJobs, keywords, allErrors);

  // Save seen URLs
  if (!isTest) {
    const allUrls = new Set([...seenUrls, ...newJobs.map((j) => j.url)]);
    // Keep only last 10000 URLs to prevent unbounded growth
    const urlArray = [...allUrls].slice(-10000);
    writeFileSync(SEEN_FILE, JSON.stringify(urlArray, null, 0));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(
    `[scraper] Done in ${elapsed}s — ${newJobs.length} new jobs (${allErrors.length} errors)`
  );

  // Output report to stdout
  console.log(report);
}

main().catch((e) => {
  console.error(`[scraper] Fatal error: ${e.message}`);
  process.exit(1);
});
