import { getProvider } from '../../../lib/ai/index.js';
import { rewriteRequestSchema } from '../../../lib/schemas.js';
import { checkRateLimit } from '../../../lib/rate-limit.js';
import { jsonWithCors, corsPreflight } from '../../../lib/cors.js';

export const runtime = 'nodejs';

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req) {
  const limitCheck = checkRateLimit(req, { bucket: 'rewrite', limit: 15, windowMs: 60000 });
  if (!limitCheck.allowed) {
    return jsonWithCors({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, { status: 429 });
  }

  let json;
  try {
    json = await req.json();
  } catch (e) {
    return jsonWithCors({ error: 'invalid_request', message: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = rewriteRequestSchema.safeParse(json);
  if (!parsed.success) {
    return jsonWithCors(
      { error: 'invalid_request', message: 'Expected { text: string, style: one of the supported styles }.' },
      { status: 400 }
    );
  }

  try {
    const provider = getProvider();
    const text = await provider.rewriteText(parsed.data.text, parsed.data.style);
    return jsonWithCors({ text });
  } catch (err) {
    console.error('[api/rewrite]', err);
    return jsonWithCors({ error: 'ai_unavailable', message: 'Could not rewrite that right now.' }, { status: 502 });
  }
}
