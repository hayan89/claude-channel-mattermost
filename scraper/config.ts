import { join } from "path";

export const PROFILE = {
  skills: {
    primary: [
      "C#", "Java", "Spring", "Spring Boot", ".NET", "ASP.NET", ".NET Core",
      "JPA", "Hibernate",
    ],
    secondary: [
      "Go", "Kotlin", "Docker", "Jenkins", "Kubernetes", "K8s", "Redis",
      "MySQL", "MSSQL", "MongoDB", "RabbitMQ", "SQS", "Amazon SQS",
      "MSA", "마이크로서비스", "Microservices",
    ],
    tertiary: [
      "Python", "AWS", "EFK", "Elasticsearch", "REST API", "CI/CD",
      "Linux", "Git", "OAuth", "Swagger", "OpenAPI",
    ],
  },
  domains: [
    "게임", "플랫폼", "결제", "빌링", "전자상거래", "커머스",
    "Backend", "백엔드", "서버", "AI", "ML", "LLM", "MLOps",
    "DevOps", "모니터링", "인증", "배치",
  ],
  experience: { startYear: 2017, years: 9 },
  locations: ["서울", "경기"],
  currentCompany: "넥슨",
  minRating: 3.3,
  keywordSets: [
    ["백엔드 개발자", "서버 개발자", "시니어 개발자"],
    ["Java Spring 개발자", "C# .NET 개발자"],
    ["MSA 개발자", "DevOps 엔지니어", "클라우드 엔지니어"],
    ["게임서버 개발자", "게임 플랫폼", "언리얼 서버"],
    ["AI 엔지니어", "ML 백엔드", "MLOps 엔지니어"],
    ["결제 백엔드", "빌링 개발자", "핀테크 개발자"],
    ["제조 IT 개발", "금융 IT 개발자", "스마트팩토리 백엔드"],
  ],
};

// Large company thresholds
export const COMPANY_TIERS = {
  large: { minRevenue: 5000, minEmployees: 1000 },  // 5000억+, 1000명+
  mid: { minRevenue: 500, minEmployees: 300 },       // 500억+, 300명+
};

export const DATA_DIR = join(new URL(".", import.meta.url).pathname, "data");
export const SEEN_FILE = join(DATA_DIR, "seen.json");

export function getTodayKeywords(): string[] {
  const dayIndex = Math.floor(
    (Date.now() + 9 * 3600000) / 86400000  // KST offset
  ) % PROFILE.keywordSets.length;
  return PROFILE.keywordSets[dayIndex];
}

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
