import type { JobListing } from "./types";
import { PROFILE, COMPANY_TIERS } from "./config";
import { lookupCompany, formatRevenue, formatEmployees } from "./companies";

const allSkills = [
  ...PROFILE.skills.primary.map((s) => ({ name: s, weight: 10 })),
  ...PROFILE.skills.secondary.map((s) => ({ name: s, weight: 7 })),
  ...PROFILE.skills.tertiary.map((s) => ({ name: s, weight: 3 })),
];

const allDomains = PROFILE.domains.map((d) => ({ name: d, weight: 5 }));

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.]/g, "");
}

export function scoreJob(job: JobListing): void {
  const searchText = normalize(
    [job.title, ...job.tags, job.company].join(" ")
  );

  let score = 0;
  const matched: string[] = [];

  // Skill matching
  for (const skill of allSkills) {
    const normalized = normalize(skill.name);
    if (searchText.includes(normalized)) {
      score += skill.weight;
      matched.push(skill.name);
    }
  }

  // Domain matching
  for (const domain of allDomains) {
    const normalized = normalize(domain.name);
    if (searchText.includes(normalized)) {
      score += domain.weight;
      if (!matched.includes(domain.name)) matched.push(domain.name);
    }
  }

  // Cap at 100
  job.matchScore = Math.min(100, score);
  job.matchTags = matched;

  // Classify and enrich company info
  enrichCompany(job);
}

function enrichCompany(job: JobListing): void {
  const known = lookupCompany(job.company);

  if (known) {
    job.companySize = known.tier;
    if (!job.revenue && known.revenue) {
      job.revenue = formatRevenue(known.revenue);
    }
    if (!job.employees && known.employees) {
      job.employees = formatEmployees(known.employees);
    }
    return;
  }

  // Fallback: try to classify from existing data
  const rev = parseRevenue(job.revenue);
  const emp = parseEmployees(job.employees);

  if (
    rev >= COMPANY_TIERS.large.minRevenue ||
    emp >= COMPANY_TIERS.large.minEmployees
  ) {
    job.companySize = "large";
  } else if (
    rev >= COMPANY_TIERS.mid.minRevenue ||
    emp >= COMPANY_TIERS.mid.minEmployees
  ) {
    job.companySize = "mid";
  } else {
    job.companySize = "small";
  }
}

function parseRevenue(rev?: string): number {
  if (!rev) return 0;
  const match = rev.match(/([\d,.]+)\s*(조|천억|억)/);
  if (!match) return 0;
  const num = parseFloat(match[1].replace(/,/g, ""));
  switch (match[2]) {
    case "조":
      return num * 10000;
    case "천억":
      return num * 1000;
    case "억":
      return num;
    default:
      return 0;
  }
}

function parseEmployees(emp?: string): number {
  if (!emp) return 0;
  const match = emp.match(/([\d,]+)/);
  if (!match) return 0;
  return parseInt(match[1].replace(/,/g, ""));
}

export function deduplicateJobs(jobs: JobListing[]): JobListing[] {
  const seen = new Map<string, JobListing>();

  for (const job of jobs) {
    const key = normalize(`${job.company}_${job.title}`);
    const existing = seen.get(key);

    if (!existing || job.matchScore > existing.matchScore) {
      seen.set(key, job);
    }
  }

  return Array.from(seen.values());
}

export function sortJobs(jobs: JobListing[]): JobListing[] {
  return jobs.sort((a, b) => {
    const sizeOrder = { large: 0, mid: 1, small: 2 };
    const sizeA = sizeOrder[a.companySize || "small"];
    const sizeB = sizeOrder[b.companySize || "small"];
    if (sizeA !== sizeB) return sizeA - sizeB;

    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;

    return 0;
  });
}
