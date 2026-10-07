/**
 * A basic sliding-window limiter, keyed by IP, held in memory.
 *
 * IMPORTANT: this only works within a single warm serverless instance.
 * Vercel runs many instances concurrently and recycles them, so in
 * production this is closer to "light friction" than a real cap — it will
 * NOT reliably stop a determined abuser. Before shipping this to real
 * users, replace it with a shared store: Vercel KV or Upstash Redis both
 * work as a drop-in (swap the Map below for a small INCR + EXPIRE call).
 *
 * Kept here anyway because "no rate limiting at all" on routes that spend
 * real AI-provider money is worse than an imperfect one, and this needs no
 * extra service to run locally or in a first deploy.
 */
const buckets = new Map();

function getClientIp(req) {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

/**
 * @param {Request} req
 * @param {{limit?: number, windowMs?: number, bucket?: string}} [opts]
 * @returns {{allowed: boolean, remaining: number, resetMs: number}}
 */
export function checkRateLimit(req, opts) {
  opts = opts || {};
  const limit = opts.limit || 20;
  const windowMs = opts.windowMs || 60000;
  const key = (opts.bucket || 'default') + ':' + getClientIp(req);
  const now = Date.now();

  let entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
  }
  entry.count += 1;
  buckets.set(key, entry);

  // Opportunistic cleanup so the Map doesn't grow unbounded on a long-lived instance.
  if (buckets.size > 5000) {
    for (const k of buckets.keys()) {
      const v = buckets.get(k);
      if (now - v.start > windowMs) buckets.delete(k);
    }
  }

  const remaining = Math.max(0, limit - entry.count);
  return {
    allowed: entry.count <= limit,
    remaining,
    resetMs: Math.max(0, windowMs - (now - entry.start))
  };
}
