import { getProvider } from '../../../lib/ai/index.js';
import { toneRequestSchema, toneResponseSchema } from '../../../lib/schemas.js';
import { checkRateLimit } from '../../../lib/rate-limit.js';
import { jsonWithCors, corsPreflight } from '../../../lib/cors.js';

export const runtime = 'nodejs';

/**
 * Best-effort rescue of model tone output before strict Zod validation.
 * Models reasonably answer with 0-1 trait scores, extra traits, or a rambling
 * note — those are salvageable; a non-object reply or a non-string primary is
 * not, and is left for Zod to reject (→ 502 invalid_ai_response).
 */
function normalizeToneShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out = { primary: raw.primary, note: raw.note };
  if (Array.isArray(raw.traits)) {
    const valid = raw.traits.filter(
      (t) => t && typeof t.name === 'string' && typeof t.score === 'number' && isFinite(t.score)
    );
    const allFractional = valid.length > 0 && valid.every((t) => t.score >= 0 && t.score <= 1);
    out.traits = valid.slice(0, 6).map((t) => ({
      name: t.name,
      score: Math.max(0, Math.min(100, allFractional ? t.score * 100 : t.score))
    }));
  }
  if (typeof raw.note === 'string' && raw.note.length > 300) out.note = raw.note.slice(0, 300);
  return out;
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req) {
  const limitCheck = checkRateLimit(req, { bucket: 'tone', limit: 15, windowMs: 60000 });
  if (!limitCheck.allowed) {
    return jsonWithCors({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, { status: 429 });
  }

  let json;
  try {
    json = await req.json();
  } catch (e) {
    return jsonWithCors({ error: 'invalid_request', message: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = toneRequestSchema.safeParse(json);
  if (!parsed.success) {
    return jsonWithCors({ error: 'invalid_request', message: 'Expected { text: string }.' }, { status: 400 });
  }

  try {
    const provider = getProvider();
    const raw = await provider.analyzeTone(parsed.data.text);
    const toneParsed = toneResponseSchema.safeParse(normalizeToneShape(raw));
    if (!toneParsed.success) {
      return jsonWithCors({ error: 'invalid_ai_response', message: 'The AI reply couldn\u2019t be read.' }, { status: 502 });
    }
    return jsonWithCors(toneParsed.data);
  } catch (err) {
    console.error('[api/tone]', err);
    return jsonWithCors({ error: 'ai_unavailable', message: 'Could not read the tone right now.' }, { status: 502 });
  }
}
