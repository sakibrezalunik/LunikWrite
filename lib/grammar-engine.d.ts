// Type declarations for lib/grammar-engine.js — kept as plain, dependency-free
// JavaScript on purpose (see that file's header comment) so it stays importable
// unchanged from the future React Native app. This file exists only to give
// TypeScript consumers in this Next.js project real type checking.

export type IssueType = 'grammar' | 'spelling' | 'punctuation' | 'clarity' | 'style';
export type Severity = 'low' | 'medium' | 'high';
export type Source = 'local' | 'ai';

export interface Issue {
  id: string;
  source: Source;
  type: IssueType;
  category: string;
  severity: Severity;
  start: number;
  end: number;
  original: string;
  suggestion: string;
  explanation: string;
  confidence: number;
}

export interface Stats {
  wordCount: number;
  charCount: number;
  sentences: number;
  readingTime: number;
  flesch: number;
  fk: number;
  avgSentLen: number;
  avgWordLen: number;
  complexPct: number;
}

export interface NormalizeOptions {
  minConfidence?: number;
}

declare const GrammarEngine: {
  DICTIONARY: Record<string, string>;
  VARIANT_PAIRS: [string, string][];
  findLocalIssues(text: string, variant?: 'US' | 'UK', personalDict?: string[]): Issue[];
  mergeIssues(local: Issue[], ai: Issue[]): Issue[];
  normalizeAIIssues(text: string, rawIssues: unknown, opts?: NormalizeOptions): Issue[];
  rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean;
  computeStats(text: string): Stats;
  countSyllables(word: string): number;
  readabilityLabel(score: number): string;
};

export default GrammarEngine;
