export interface JobListing {
  id: string;
  title: string;
  company: string;
  location: string;
  experience: string;
  source: "jobkorea" | "wanted" | "saramin" | "jumpit";
  url: string;
  tags: string[];
  companySize?: "large" | "mid" | "small";
  revenue?: string;
  employees?: string;
  rating?: number;
  deadline?: string;
  matchScore: number;
  matchTags: string[];
  salary?: string;
}

export interface ScrapeResult {
  jobs: JobListing[];
  errors: string[];
}
