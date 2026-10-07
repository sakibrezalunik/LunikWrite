// Type declarations for lib/writing-health.js — see grammar-engine.d.ts for
// why this project ships plain JavaScript with adjacent .d.ts files.

export interface HealthMetric {
  key: string;
  label: string;
  score: number;
  detail: string;
}

export interface HealthResult {
  overall: number;
  label: string;
  metrics: HealthMetric[];
}

declare const WritingHealth: {
  computeWritingHealth(text: string, issues?: { severity?: string }[]): HealthResult | null;
};

export default WritingHealth;
