/**
 * Small helpers shared by every AI provider (Groq, Gemini, ...).
 * Nothing provider-specific belongs here.
 */

/** Strip common markdown-fence wrapping a model sometimes adds despite instructions, then parse. */
export function parseJsonLoose(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}

/**
 * Did a provider error a SECOND provider have a real chance of fixing?
 * Conservative by design: only transient availability problems qualify.
 * Never true for request-validation or data problems a fallback would
 * just repeat (input too large, malformed request, unusable model output
 * twice in a row is already retried by the primary's own one-retry rule),
 * and never for auth/configuration failures (a different provider cannot
 * fix a missing/revoked key — and hiding it would be worse).
 */
export function isTransientProviderError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 'rate_limited' || code === 'upstream_error') return true;   // 429, timeouts, net errors, other 5xx
  if (code === 'empty_response' || code === 'invalid_json') return true;   // model returned junk — another model may behave
  return false;
}

/** Best-effort scrub of an API key out of a thrown error message before logging. */
function scrub(value, keys) {
  let out = value;
  keys.forEach(function (k) {
    if (k && typeof k === 'string' && k.length >= 8 && out.indexOf(k) !== -1) {
      out = out.split(k).join('[REDACTED]');
    }
  });
  return out;
}

/**
 * Bounded fallback: primary → (at most ONE secondary attempt) → throw.
 * The chain is built ONCE per request; providers are called through the
 * existing provider objects. The secondary is tried only when the primary
 * failed with a TRANSIENT error (see isTransientProviderError) or when the
 * primary was not callable at all (its key is not configured). A missing
 * key never masks the underlying cause: the FIRST error (the real one) is
 * what surfaces to the route handler when both legs fail, and each failed
 * attempt is logged (sanitized) so configuration problems stay visible.
 *
 * Never loops: index.js builds [primary, secondary] with distinct names,
 * and each entry is attempted at most once.
 */
export async function callWithFallback(chain, method, args, env, log) {
  const keys = [env.GROQ_API_KEY, env.GEMINI_API_KEY, env.GOOGLE_AI_API_KEY].filter(Boolean);
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    try {
      return await entry.provider[method].apply(entry.provider, args);
    } catch (err) {
      // Distinguish a provider THAT this attempt reached (429/5xx/format
      // errors — transient, fallback is allowed) from one that was never
      // callable (missing key — configuration, not availability). A
      // missing key lets the request continue to the other configured
      // provider but is always logged so the config problem stays visible.
      const isAuth = err && err.code === 'missing_api_key';
      const transient = isTransientProviderError(err);
      if (!isAuth && !transient) {
        throw err;
      }
      // When the NEXT provider is missing its key, surface the PRIMARY
      // error (the real cause), not the secondary's missing-key error —
      // otherwise a provider 429 inside the app's own 429-classified path
      // would be re-labeled as a 502-class configuration failure.
      lastErr = i === 0 ? err : (lastErr || err);
      const hasNext = i + 1 < chain.length;
      // Log ONE sanitized line per failed attempt — never the key, never the
      // model's reply body (that would leak the user's document).
      const reason = isAuth
        ? 'missing_api_key'
        : transient && err.status
          ? 'provider_' + err.status
          : transient
            ? 'provider_' + String(err.code || 'unknown')
            : null;
      if (reason && log) {
        log('[' + entry.name + '] failed (' + reason + '), ' + (hasNext ? 'falling back to ' + chain[i + 1].name : 'no further provider'));
      }
      if (!hasNext) break;
      if (env && env.DIAGNOSTIC_LOG === '1') {
        // Extra sanitized diagnostics: status/code only, message with keys scrubbed.
        const msg = err && err.message ? scrub(String(err.message), keys) : 'no message';
        if (log) log('[' + entry.name + '] detail: ' + msg.slice(0, 200));
      }
    }
  }
  throw lastErr;
}
