import type { JobListing } from "./types";

function formatDate(): string {
  const now = new Date(Date.now() + 9 * 3600000); // KST
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const dayName = days[now.getUTCDay()];
  return `${y}-${m}-${d} (${dayName})`;
}

function formatJob(job: JobListing, index: number): string {
  const parts: string[] = [];

  parts.push(`**${index}. [${job.company}] ${job.title}**`);

  const info: string[] = [];
  if (job.location) info.push(`📍 ${job.location}`);
  if (job.experience) info.push(`💼 ${job.experience}`);
  info.push(`📌 ${sourceLabel(job.source)}`);
  if (job.revenue) info.push(`💰 매출 ${job.revenue}`);
  if (job.employees) info.push(`👥 ${job.employees}`);
  if (info.length) parts.push(info.join(" | "));

  if (job.matchTags.length > 0) {
    parts.push(`🏷 매칭: ${job.matchTags.join(", ")}`);
  }

  parts.push(`📊 매칭 점수: ${job.matchScore}점${job.matchScore >= 60 ? " 🎯" : ""}`);
  parts.push(`🔗 ${job.url}`);

  if (job.deadline) {
    const today = formatDate().slice(0, 10);
    if (job.deadline.includes(today) || job.deadline.includes("오늘")) {
      parts[0] += " ⚠️ 오늘 마감!";
    }
  }

  return parts.join("\n");
}

function sourceLabel(source: string): string {
  switch (source) {
    case "jobkorea": return "잡코리아";
    case "wanted": return "원티드";
    case "saramin": return "사람인";
    case "jumpit": return "점핏";
    default: return source;
  }
}

export function formatReport(
  jobs: JobListing[],
  keywords: string[],
  errors: string[]
): string {
  const date = formatDate();

  const large = jobs.filter((j) => j.companySize === "large");
  const mid = jobs.filter((j) => j.companySize === "mid");
  const highMatch = jobs.filter(
    (j) => j.matchScore >= 60 && j.companySize !== "large"
  );
  const others = jobs.filter(
    (j) =>
      j.companySize !== "large" &&
      j.companySize !== "mid" &&
      j.matchScore < 60
  );

  // Stats
  const bySource: Record<string, number> = {};
  for (const j of jobs) {
    bySource[j.source] = (bySource[j.source] || 0) + 1;
  }

  const sections: string[] = [];

  // Header
  sections.push(
    `🗓 **${date} 이직 공고 리포트**\n검색 키워드: ${keywords.join(", ")}`
  );

  // Large companies
  if (large.length > 0) {
    sections.push(
      `🏢 **대기업 공고** — ${large.length}건\n---\n` +
        large.map((j, i) => formatJob(j, i + 1)).join("\n\n")
    );
  }

  // High match
  if (highMatch.length > 0) {
    const sorted = highMatch.sort((a, b) => b.matchScore - a.matchScore);
    sections.push(
      `⭐ **높은 매칭 공고 (60점 이상)** — ${sorted.length}건\n---\n` +
        sorted
          .slice(0, 10)
          .map((j, i) => formatJob(j, i + 1))
          .join("\n\n")
    );
  }

  // Mid companies
  if (mid.length > 0) {
    const sorted = mid.sort((a, b) => b.matchScore - a.matchScore);
    const display = sorted.slice(0, 10);
    sections.push(
      `🏛 **중견기업/유니콘 공고** — ${mid.length}건\n---\n` +
        display.map((j, i) => formatJob(j, i + 1)).join("\n\n") +
        (mid.length > 10
          ? `\n(이하 ${mid.length - 10}건 생략)`
          : "")
    );
  }

  // Other notable
  if (others.length > 0) {
    const sorted = others.sort((a, b) => b.matchScore - a.matchScore);
    const notable = sorted.filter((j) => j.matchScore > 0).slice(0, 8);
    if (notable.length > 0) {
      sections.push(
        `📋 **기타 주목 공고 (매칭 점수순)**\n` +
          notable
            .map(
              (j) =>
                `- **[${j.company}]** ${j.title} — ${j.matchScore}점${j.matchTags.length ? ` (${j.matchTags.slice(0, 5).join(", ")})` : ""} 🔗 ${j.url}`
            )
            .join("\n")
      );
    }
  }

  // Summary
  const sourceStats = Object.entries(bySource)
    .map(([s, n]) => `${sourceLabel(s)} ${n}`)
    .join(" / ");

  sections.push(
    `📊 **오늘의 요약**\n` +
      `- 신규 공고: **${jobs.length}건** (${sourceStats})\n` +
      `- 🏢 대기업: ${large.length}건 | 🏛 중견: ${mid.length}건 | ⭐ 높은 매칭: ${highMatch.length}건` +
      (errors.length > 0
        ? `\n- ⚠️ 오류: ${errors.length}건 (${errors.slice(0, 3).join("; ")})`
        : "")
  );

  return sections.join("\n\n");
}
