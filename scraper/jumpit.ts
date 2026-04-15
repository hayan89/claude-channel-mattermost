import { type Browser, chromium } from "playwright";
import type { JobListing, ScrapeResult } from "./types";
import { UA } from "./config";

const SEARCH_URL =
  "https://jumpit.saramin.co.kr/positions?sort=rsp_rate&keyword=";

export async function scrapeJumpit(
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

    await page.route(
      /\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)$/,
      (route) => route.abort()
    );

    for (const keyword of keywords) {
      try {
        const url = `${SEARCH_URL}${encodeURIComponent(keyword)}`;
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(3000);

        const listings = await page.evaluate(() => {
          const links = document.querySelectorAll('a[href*="/position/"]');
          return Array.from(links).map((link) => {
            const href = link.getAttribute("href") || "";
            const idMatch = href.match(/\/position\/(\d+)/);
            if (!idMatch) return null;
            const id = idMatch[1];

            // Company: second SPAN (first is deadline badge)
            const spans = link.querySelectorAll("span");
            let company = "";
            for (const span of spans) {
              const text = span.textContent?.trim() || "";
              if (text && !/^D-\d+$/.test(text)) {
                company = text;
                break;
              }
            }

            // Title: H2 element
            const h2 = link.querySelector("h2");
            const title = h2?.textContent?.trim() || "";

            // Tech stacks and metadata from LI elements
            const lis = link.querySelectorAll("li");
            const tags: string[] = [];
            let location = "";
            let experience = "";

            for (const li of lis) {
              const text = li.textContent?.trim().replace(/^·\s*/, "") || "";
              if (!text) continue;

              // Location check
              if (
                /^(서울|경기|인천|부산|대구|대전|광주|울산|세종|제주)/.test(
                  text
                )
              ) {
                location = text;
              } else if (/^(신입|경력|[\d~]+년)/.test(text)) {
                experience = text;
              } else {
                tags.push(text);
              }
            }

            // Deadline from badge
            const badge = link.querySelector("span[class]");
            const deadline = badge?.textContent?.trim() || "";

            return { id, title, company, tags, location, experience, deadline };
          });
        });

        for (const listing of listings) {
          if (!listing || !listing.title) continue;
          if (seen.has(listing.id)) continue;
          seen.add(listing.id);

          // Skip entry-level only
          if (listing.experience === "신입") continue;

          jobs.push({
            id: `jumpit_${listing.id}`,
            title: listing.title,
            company: listing.company,
            location: listing.location,
            experience: listing.experience,
            source: "jumpit",
            url: `https://jumpit.saramin.co.kr/position/${listing.id}`,
            tags: listing.tags,
            deadline: listing.deadline,
            matchScore: 0,
            matchTags: [],
          });
        }
      } catch (e: any) {
        errors.push(`Jumpit error for "${keyword}": ${e.message}`);
      }
    }

    await context.close();
  } catch (e: any) {
    errors.push(`Jumpit browser error: ${e.message}`);
  } finally {
    if (ownBrowser) await browser.close();
  }

  return { jobs, errors };
}
