import { chromium, type Browser } from "playwright";
import type { JobListing, ScrapeResult } from "./types";
import { UA, PROFILE } from "./config";

const SEARCH_URL = "https://www.jobkorea.co.kr/Search/?stext=";

export async function scrapeJobKorea(
  keywords: string[],
  browser?: Browser
): Promise<ScrapeResult> {
  const ownBrowser = !browser;
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }

  const jobs: JobListing[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "ko-KR",
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    // Block heavy resources
    await page.route(
      /\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)$/,
      (route) => route.abort()
    );

    for (const keyword of keywords) {
      try {
        for (let pageNum = 1; pageNum <= 3; pageNum++) {
          const url = `${SEARCH_URL}${encodeURIComponent(keyword)}&tabType=recruit&Page_No=${pageNum}`;
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await page.waitForTimeout(2000);

          const listings = await page.evaluate(() => {
            const cards = document.querySelectorAll(
              '[data-sentry-component="CardJob"]'
            );

            return Array.from(cards).map((card) => {
              const links = card.querySelectorAll('a[href*="GI_Read"]');
              const linkTexts = Array.from(links)
                .map((a) => ({
                  text: a.textContent?.trim() || "",
                  href: a.getAttribute("href") || "",
                }))
                .filter((l) => l.text);

              // First non-empty link text = title, second = company
              const title = linkTexts[0]?.text || "";
              const company = linkTexts[1]?.text || "";
              const href = linkTexts[0]?.href || "";

              // Extract metadata from span elements
              const spans = Array.from(card.querySelectorAll("span")).map(
                (s) => s.textContent?.trim() || ""
              );

              // Location: contains 시/구/도 patterns
              const location =
                spans.find(
                  (s) =>
                    /^(서울|경기|인천|부산|대구|대전|광주|울산|세종|제주)/.test(s) &&
                    s.length < 30
                ) || "";

              // Experience: contains 경력/신입
              const experience =
                spans.find((s) => /^(경력|신입)/.test(s)) || "";

              // Deadline: contains 마감
              const deadline =
                spans.find((s) => s.includes("마감")) || "";

              // Salary
              const salary =
                spans.find((s) => s.includes("연봉") || s.includes("만원")) ||
                "";

              // Industry/category info
              const category =
                spans.find(
                  (s) =>
                    (s.includes(",") || s.includes("·")) &&
                    !s.includes("등록") &&
                    !s.includes("마감") &&
                    !s.includes("연봉")
                ) || "";

              // Extract GI_Read ID from URL
              const idMatch = href.match(/GI_Read\/(\d+)/);
              const id = idMatch ? idMatch[1] : "";

              return {
                id,
                title,
                company,
                location,
                experience,
                deadline,
                salary,
                category,
                url: href.split("?")[0], // Clean URL
              };
            });
          });

          for (const listing of listings) {
            if (!listing.title || !listing.company) continue;
            if (seen.has(listing.id)) continue;
            seen.add(listing.id);

            // Skip entry-level only
            if (listing.experience === "신입") continue;

            // Filter by location
            if (
              listing.location &&
              !PROFILE.locations.some((l) => listing.location.includes(l))
            )
              continue;

            // Extract tags from category
            const tags = listing.category
              ? listing.category.split(/[,·]/).map((t) => t.trim())
              : [];

            jobs.push({
              id: `jobkorea_${listing.id}`,
              title: listing.title,
              company: listing.company,
              location: listing.location,
              experience: listing.experience,
              source: "jobkorea",
              url: listing.url || `https://www.jobkorea.co.kr/Recruit/GI_Read/${listing.id}`,
              tags,
              deadline: listing.deadline,
              salary: listing.salary,
              matchScore: 0,
              matchTags: [],
            });
          }
        }
      } catch (e: any) {
        errors.push(`JobKorea error for "${keyword}": ${e.message}`);
      }
    }

    await context.close();
  } catch (e: any) {
    errors.push(`JobKorea browser error: ${e.message}`);
  } finally {
    if (ownBrowser) await browser.close();
  }

  return { jobs, errors };
}
