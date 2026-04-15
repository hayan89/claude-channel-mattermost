import { chromium, type Browser, type Page } from "playwright";
import type { JobListing, ScrapeResult } from "./types";
import { UA, PROFILE } from "./config";

const SEARCH_URL =
  "https://www.saramin.co.kr/zf_user/search/recruit?searchword=";

export async function scrapeSaramin(
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

    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", (route) =>
      route.abort()
    );

    for (const keyword of keywords) {
      try {
        for (let pageNum = 1; pageNum <= 3; pageNum++) {
          const url = `${SEARCH_URL}${encodeURIComponent(keyword)}&recruitPage=${pageNum}&recruitSort=relation&recruitPageCount=40&loc_mcd=101000%2C102000`;
          // loc_mcd: 101000=서울, 102000=경기

          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
          await page.waitForTimeout(2500);

          const listings = await page.evaluate(() => {
            const items = document.querySelectorAll(
              ".item_recruit, .content_recruit .item"
            );
            const results: any[] = [];

            items.forEach((el) => {
              const titleEl =
                el.querySelector(".job_tit a") ||
                el.querySelector(".area_job .job_tit a") ||
                el.querySelector("h2.job_tit a");
              const companyEl =
                el.querySelector(".corp_name a") ||
                el.querySelector(".area_corp .corp_name a");

              const condEls = el.querySelectorAll(
                ".job_condition span, .area_job .job_condition span"
              );
              const conditions = Array.from(condEls).map(
                (e) => e.textContent?.trim() || ""
              );

              const href = titleEl?.getAttribute("href") || "";
              const fullUrl = href.startsWith("http")
                ? href
                : `https://www.saramin.co.kr${href}`;

              // Extract rec_idx from URL
              const idMatch = href.match(/rec_idx=(\d+)/);
              const id = idMatch ? idMatch[1] : href;

              // Company info
              const infoEl = el.querySelector(
                ".area_corp .corp_name .corp_tag, .company_tag"
              );
              const corpInfo = infoEl?.textContent?.trim() || "";

              results.push({
                id,
                title: titleEl?.textContent?.trim() || "",
                company: companyEl?.textContent?.trim() || "",
                url: fullUrl,
                location: conditions[0] || "",
                experience: conditions[1] || "",
                education: conditions[2] || "",
                deadline:
                  conditions.find((c) => /~|마감|D-/.test(c)) || "",
                corpInfo,
              });
            });

            return results.filter((r) => r.title && r.company);
          });

          for (const listing of listings) {
            const key = listing.id || listing.url;
            if (seen.has(key)) continue;
            seen.add(key);

            // Skip entry-level only
            if (listing.experience === "신입") continue;

            // Filter location (already filtered by loc_mcd, but double check)
            if (
              listing.location &&
              !PROFILE.locations.some((l) =>
                listing.location.includes(l)
              ) &&
              listing.location !== ""
            )
              continue;

            // Parse company info
            let employees: string | undefined;
            let revenue: string | undefined;
            const empMatch = listing.corpInfo?.match(
              /(\d[\d,]*)\s*명/
            );
            if (empMatch) employees = empMatch[0];
            const revMatch = listing.corpInfo?.match(
              /([\d,.]+)\s*(조|억)/
            );
            if (revMatch) revenue = `${revMatch[1]}${revMatch[2]}`;

            jobs.push({
              id: `saramin_${key}`,
              title: listing.title,
              company: listing.company,
              location: listing.location,
              experience: listing.experience,
              source: "saramin",
              url: listing.url,
              tags: [],
              employees,
              revenue,
              deadline: listing.deadline,
              matchScore: 0,
              matchTags: [],
            });
          }

          // Check if there are more pages
          const hasNext = await page.evaluate((pn: number) => {
            const pageLinks = document.querySelectorAll(
              ".pagination a, .page_navigation a"
            );
            return Array.from(pageLinks).some((a) =>
              a.textContent?.trim() === String(pn + 1)
            );
          }, pageNum);

          if (!hasNext) break;
        }
      } catch (e: any) {
        errors.push(`Saramin error for "${keyword}": ${e.message}`);
      }
    }

    await context.close();
  } catch (e: any) {
    errors.push(`Saramin browser error: ${e.message}`);
  } finally {
    if (ownBrowser) await browser.close();
  }

  return { jobs, errors };
}
