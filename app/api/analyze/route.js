import GrammarEngine from '../../../lib/grammar-engine.js';
import { getProvider } from '../../../lib/ai/index.js';
import { summarizeGroqError } from '../../../lib/ai/diagnostic-helper.js';
import { analyzeRequestSchema, MAX_DOC_CHARS } from '../../../lib/schemas.js';
import { checkRateLimit } from '../../../lib/rate-limit.js';
import { jsonWithCors, corsPreflight } from '../../../lib/cors.js';

// Force the Node runtime (not Edge) — this route uses process.env directly
export const runtime = 'nodejs';

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req) {
  const limitCheck = checkRateLimit(req, { bucket: 'analyze', limit: 30, windowMs: 60000 });
  if (!limitCheck.allowed) {
    return jsonWithCors(
      { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
      { status: 429 }
    );
  }

  let json;
  try {
    json = await req.json();
  } catch (e) {
    return jsonWithCors({ error: 'invalid_request', message: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = analyzeRequestSchema.safeParse(json);
  if (!parsed.success) {
    return jsonWithCors(
      { error: 'invalid_request', message: 'Expected { text: string } up to ' + MAX_DOC_CHARS + ' characters.' },
      { status: 400 }
    );
  }

  // Match the model's context window to what prompts.js actually sends it (see MAX_CHARS there),
  // so the offsets we validate against are the same string the model saw.
  const text = parsed.data.text.length > 6000 ? parsed.data.text.slice(0, 6000) : parsed.data.text;

  try {
    const provider = getProvider();
    const raw = await provider.analyzeGrammar(text);
    const issues = GrammarEngine.normalizeAIIssues(text, raw, { minConfidence: 0.7 });
    return jsonWithCors({ issues, truncatedAt: text.length < parsed.data.text.length ? text.length : null });
  } catch (err) {
    console.error('[api/analyze]', summarizeGroqError(err));
    const status = err && err.code === 'rate_limited' ? 429 : 502;
    return jsonWithCors({ error: 'ai_unavailable', message: 'Could not analyze this text right now.' }, { status });
  }
}
