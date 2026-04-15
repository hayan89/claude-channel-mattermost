import type { JobListing, ScrapeResult } from "./types";
import { UA, PROFILE } from "./config";

const API_BASE = "https://www.wanted.co.kr/api/v4/jobs";

interface WantedJob {
  id: number;
  position: string;
  company: {
    id: number;
    name: string;
    industry_name?: string;
    application_response_stats?: { avg_rate?: number; level?: string };
  };
  address?: {
    location?: string;
    location_key?: string;
    district?: string;
    country?: string;
    full_location?: string;
  };
  reward?: { formatted_total?: string };
  like_count?: number;
  skill_tags?: { title: string }[];
  due_time?: string | null;
  category_tags?: { parent_id: number; id: number }[];
  annual_from?: number;
  annual_to?: number;
}

interface WantedResponse {
  data: WantedJob[];
  links?: { next?: string };
}

export async function scrapeWanted(keywords: string[]): Promise<ScrapeResult> {
  const jobs: JobListing[] = [];
  const errors: string[] = [];
  const seen = new Set<number>();

  for (const keyword of keywords) {
    try {
      let offset = 0;
      const limit = 50;
      let hasMore = true;

      while (hasMore && offset < 150) {
        const params = new URLSearchParams({
          country: "kr",
          job_sort: "job.latest_order",
          years: "1",
          limit: String(limit),
          offset: String(offset),
          query: keyword,
        });

        const res = await fetch(`${API_BASE}?${params}`, {
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            "Accept-Language": "ko-KR,ko;q=0.9",
            "wanted-user-country": "KR",
            "wanted-user-language": "ko",
          },
        });

        if (!res.ok) {
          errors.push(`Wanted API ${res.status} for "${keyword}"`);
          break;
        }

        const data: WantedResponse = await res.json();
        const items = data.data || [];

        for (const job of items) {
          if (seen.has(job.id)) continue;
          seen.add(job.id);

          const loc = job.address?.full_location || job.address?.location || "";
          const locKey = job.address?.location_key || "";
          // Filter: Seoul or Gyeonggi only
          if (
            !PROFILE.locations.some((l) => loc.includes(l)) &&
            !["seoul", "gyeonggi"].some((k) => locKey.includes(k))
          )
            continue;

          const tags = (job.skill_tags || []).map((t) => t.title);

          const expFrom = job.annual_from ?? 0;
          const expTo = job.annual_to ?? 0;
          // Skip entry-level only (max 0 years)
          if (expTo === 0 && expFrom === 0) {
            // OK: "경력무관" — include it
          }
          const experience =
            expFrom > 0 || expTo > 0
              ? `${expFrom}~${expTo}년`
              : "경력무관";

          jobs.push({
            id: `wanted_${job.id}`,
            title: job.position,
            company: job.company?.name || "",
            location: loc,
            experience,
            source: "wanted",
            url: `https://www.wanted.co.kr/wd/${job.id}`,
            tags,
            deadline: job.due_time || undefined,
            matchScore: 0,
            matchTags: [],
          });
        }

        hasMore = items.length === limit;
        offset += limit;
      }
    } catch (e: any) {
      errors.push(`Wanted error for "${keyword}": ${e.message}`);
    }
  }

  return { jobs, errors };
}

// Fetch detailed job info for enrichment
export async function fetchWantedDetail(
  jobId: number
): Promise<{
  experience?: string;
  skills?: string[];
  intro?: string;
} | null> {
  try {
    const res = await fetch(
      `https://www.wanted.co.kr/api/v4/jobs/${jobId}`,
      {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "wanted-user-country": "KR",
          "wanted-user-language": "ko",
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const job = data.job || data;
    return {
      experience: job.detail?.requirements
        ? `${job.min_year || 0}~${job.max_year || 0}년`
        : undefined,
      skills: (job.skill_tags || []).map((t: any) => t.title),
      intro: job.detail?.intro || undefined,
    };
  } catch {
    return null;
  }
}
