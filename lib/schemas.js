import { z } from 'zod';

export const MAX_DOC_CHARS = 20000;
export const MAX_SNIPPET_CHARS = 4000;

export const analyzeRequestSchema = z.object({
  text: z.string().min(1, 'text is required').max(MAX_DOC_CHARS)
});

export const toneRequestSchema = z.object({
  text: z.string().min(1, 'text is required').max(MAX_DOC_CHARS)
});

export const REWRITE_STYLES = ['improve', 'shorten', 'expand', 'simplify', 'formal', 'casual', 'persuasive'];
export const rewriteRequestSchema = z.object({
  text: z.string().min(1, 'text is required').max(MAX_SNIPPET_CHARS),
  style: z.enum(REWRITE_STYLES)
});

export const summarizeRequestSchema = z.object({
  text: z.string().min(1, 'text is required').max(MAX_DOC_CHARS)
});

const toneTraitSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(100)
});
export const toneResponseSchema = z.object({
  primary: z.string().default(''),
  traits: z.array(toneTraitSchema).max(6).default([]),
  note: z.string().max(300).default('')
});
