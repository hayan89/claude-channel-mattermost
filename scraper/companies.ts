// Known Korean tech/large companies for automatic classification
// revenue: in 억원, employees: headcount
interface CompanyInfo {
  revenue?: number;
  employees?: number;
  tier: "large" | "mid";
}

const KNOWN_COMPANIES: Record<string, CompanyInfo> = {
  // === 대기업 (Large) ===
  삼성전자: { revenue: 2600000, employees: 120000, tier: "large" },
  삼성SDS: { revenue: 130000, employees: 15000, tier: "large" },
  비젠트로: { revenue: 130000, employees: 15000, tier: "large" },
  LG전자: { revenue: 840000, employees: 75000, tier: "large" },
  LGCNS: { revenue: 60000, employees: 9000, tier: "large" },
  "LG CNS": { revenue: 60000, employees: 9000, tier: "large" },
  SK하이닉스: { revenue: 170000, employees: 5500, tier: "large" },
  현대자동차: { revenue: 1600000, employees: 75000, tier: "large" },
  현대오토에버: { revenue: 30000, employees: 5000, tier: "large" },
  기아: { revenue: 1000000, employees: 52000, tier: "large" },
  네이버: { revenue: 95000, employees: 6000, tier: "large" },
  네이버클라우드: { revenue: 95000, employees: 6000, tier: "large" },
  네이버랩스: { revenue: 95000, employees: 6000, tier: "large" },
  카카오: { revenue: 80000, employees: 6000, tier: "large" },
  카카오페이: { revenue: 75000, employees: 6000, tier: "large" },
  카카오뱅크: { revenue: 30000, employees: 3000, tier: "large" },
  카카오엔터프라이즈: { revenue: 10000, employees: 1000, tier: "large" },
  카카오페이손해보험: { revenue: 10000, employees: 1000, tier: "large" },
  쿠팡: { revenue: 310000, employees: 70000, tier: "large" },
  배달의민족: { revenue: 30000, employees: 4000, tier: "large" },
  우아한형제들: { revenue: 30000, employees: 4000, tier: "large" },
  토스: { revenue: 15000, employees: 3000, tier: "large" },
  비바리퍼블리카: { revenue: 15000, employees: 3000, tier: "large" },
  토스뱅크: { revenue: 10000, employees: 1000, tier: "large" },
  토스인슈어런스: { revenue: 5000, employees: 500, tier: "large" },
  토스플레이스: { revenue: 5000, employees: 1000, tier: "large" },
  당근: { revenue: 5000, employees: 1200, tier: "large" },
  당근마켓: { revenue: 5000, employees: 1200, tier: "large" },
  라인: { revenue: 120000, employees: 3000, tier: "large" },
  "LINE": { revenue: 120000, employees: 3000, tier: "large" },
  넥슨: { revenue: 40000, employees: 7000, tier: "large" },
  넥슨코리아: { revenue: 40000, employees: 7000, tier: "large" },
  "㈜넥슨": { revenue: 40000, employees: 7000, tier: "large" },
  "㈜넥슨코리아": { revenue: 40000, employees: 7000, tier: "large" },
  엔씨소프트: { revenue: 17000, employees: 4000, tier: "large" },
  넷마블: { revenue: 24000, employees: 6000, tier: "large" },
  크래프톤: { revenue: 20000, employees: 3000, tier: "large" },
  스마일게이트: { revenue: 20000, employees: 3000, tier: "large" },
  컴투스: { revenue: 6000, employees: 1200, tier: "large" },
  웹젠: { revenue: 3000, employees: 500, tier: "large" },
  NHN: { revenue: 20000, employees: 4000, tier: "large" },
  "NHN KCP": { revenue: 20000, employees: 4000, tier: "large" },
  신한은행: { revenue: 150000, employees: 13000, tier: "large" },
  KB손해보험: { revenue: 100000, employees: 5000, tier: "large" },
  "KB데이타시스템": { revenue: 5000, employees: 2000, tier: "large" },
  "KT DS": { revenue: 250000, employees: 22000, tier: "large" },
  "KT": { revenue: 250000, employees: 22000, tier: "large" },
  두산로보틱스: { revenue: 170000, employees: 35000, tier: "large" },
  "GS리테일": { revenue: 110000, employees: 10000, tier: "large" },
  "CJ올리브영": { revenue: 40000, employees: 5000, tier: "large" },
  CJ: { revenue: 400000, employees: 80000, tier: "large" },
  롯데: { revenue: 600000, employees: 100000, tier: "large" },

  // === 중견기업/유니콘 (Mid) ===
  야놀자: { revenue: 5000, employees: 1000, tier: "mid" },
  무신사: { revenue: 10000, employees: 1500, tier: "mid" },
  컬리: { revenue: 20000, employees: 3000, tier: "mid" },
  리디: { revenue: 3000, employees: 800, tier: "mid" },
  왓챠: { revenue: 2000, employees: 300, tier: "mid" },
  버킷플레이스: { revenue: 2000, employees: 500, tier: "mid" },
  오늘의집: { revenue: 2000, employees: 500, tier: "mid" },
  직방: { revenue: 2000, employees: 500, tier: "mid" },
  원티드랩: { revenue: 1000, employees: 400, tier: "mid" },
  원티드긱스: { revenue: 1000, employees: 150, tier: "mid" },
  코인원: { revenue: 2000, employees: 300, tier: "mid" },
  업비트: { revenue: 10000, employees: 1000, tier: "mid" },
  두나무: { revenue: 10000, employees: 1000, tier: "mid" },
  빗썸: { revenue: 5000, employees: 500, tier: "mid" },
  그라비티: { revenue: 1000, employees: 300, tier: "mid" },
  키다리스튜디오: { revenue: 1000, employees: 300, tier: "mid" },
  삼양식품: { revenue: 15000, employees: 3000, tier: "mid" },
  바비톡: { revenue: 500, employees: 300, tier: "mid" },
  스캐터랩: { revenue: 500, employees: 300, tier: "mid" },
  플리토: { revenue: 500, employees: 300, tier: "mid" },
  라인게임즈: { revenue: 2000, employees: 500, tier: "mid" },
  데브시스터즈: { revenue: 5000, employees: 1000, tier: "mid" },
  펄어비스: { revenue: 5000, employees: 1200, tier: "mid" },
  옥토스: { revenue: 15000, employees: 3000, tier: "mid" },
  교보문고: { revenue: 20000, employees: 3000, tier: "mid" },
  한패스: { revenue: 1000, employees: 300, tier: "mid" },
  중고나라: { revenue: 1000, employees: 300, tier: "mid" },
  구름: { revenue: 500, employees: 300, tier: "mid" },
};

export function lookupCompany(
  name: string
): CompanyInfo | null {
  // Direct match
  if (KNOWN_COMPANIES[name]) return KNOWN_COMPANIES[name];

  // Partial match (company name might include parentheses or prefixes)
  const cleaned = name
    .replace(/^[㈜(주)]+\s*/, "")
    .replace(/\s*\(.*\)$/, "")
    .trim();
  if (KNOWN_COMPANIES[cleaned]) return KNOWN_COMPANIES[cleaned];

  // Strict prefix/suffix match for known names (2+ chars)
  // Only match if the known name is at a word boundary
  for (const [key, info] of Object.entries(KNOWN_COMPANIES)) {
    if (key.length < 3) continue; // Skip short names to avoid false matches
    // Check if company name starts/ends with or exactly equals a known name
    if (
      cleaned === key ||
      cleaned.startsWith(key) ||
      name.startsWith(`(주)${key}`) ||
      name.startsWith(`㈜${key}`)
    ) {
      return info;
    }
  }

  return null;
}

export function formatRevenue(revenue?: number): string | undefined {
  if (!revenue) return undefined;
  if (revenue >= 10000) return `${Math.round(revenue / 10000)}조 ${Math.round((revenue % 10000) / 1000)}천억`;
  if (revenue >= 1000) return `${Math.round(revenue / 1000)}천억`;
  return `${revenue}억`;
}

export function formatEmployees(employees?: number): string | undefined {
  if (!employees) return undefined;
  if (employees >= 10000) return `${(employees / 10000).toFixed(1)}만명`;
  return `${employees.toLocaleString()}명`;
}
