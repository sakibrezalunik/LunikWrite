import * as prompts from './prompts.js';
import { parseJsonLoose } from './shared.js';

/**
 * Google Gemini provider (Google AI Studio / Generative Language API).
 *
 * Uses the OFFICIAL Gemini REST API directly with fetch
 * (https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent)
 * — the same zero-SDK approach as the Anthropic provider, so no new
 * dependency is introduced. Never call this from client code:
 * GEMINI_API_KEY / GOOGLE_AI_API_KEY must stay server-side.
 *
 * Auth: the key is sent in the `x-goog-api-key` HEADER (never in the URL
 * query string, so it cannot leak into access logs).
 */
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const TIMEOUT_MS = 30000;

function getApiKey() {
  // GEMINI_API_KEY is the official docs' name; GOOGLE_AI_API_KEY is accepted
  // as an alias (same Google AI Studio key).
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
}

/**
 * Sends one prompt to Gemini and returns the raw text of the first
 * candidate. Never logs or embeds the API key in thrown errors.
 */
async function callGemini(prompt, options) {
  options = options || {};
  const apiKey = getApiKey();
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY (or GOOGLE_AI_API_KEY) is not set on the server.');
    err.code = 'missing_api_key';
    throw err;
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  const generationConfig = {
    maxOutputTokens: options.maxTokens || 1000
  };
  if (typeof options.temperature === 'number') {
    generationConfig.temperature = options.temperature;
  }
  // JSON mode: for prompts that require a pure-JSON reply, ask Gemini to
  // constrain its output to application/json (deterministic, no prose).
  if (options.json) {
    generationConfig.responseMimeType = 'application/json';
  }

  let res;
  try {
    res = await fetch(GEMINI_API_URL + '/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: generationConfig
      }),
      signal: AbortSignal.timeout(options.timeoutMs || TIMEOUT_MS)
    });
  } catch (fetchErr) {
    // Network failure or timeout (AbortSignal.timeout rejects with a TimeoutError).
    const err = new Error('Gemini API request failed: ' + (fetchErr && fetchErr.name === 'TimeoutError' ? 'timed out after ' + (options.timeoutMs || TIMEOUT_MS) + 'ms' : 'network error'));
    err.code = 'upstream_error';
    throw err;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    // Scrub the key out of any provider error body before it can end up in
    // a message or log — defense in depth; Google does not echo the key.
    const safeBody = apiKey ? bodyText.split(apiKey).join('[REDACTED]') : bodyText;
    const apiErr = new Error('Gemini API error ' + res.status + ': ' + safeBody.slice(0, 300));
    apiErr.code = res.status === 429 ? 'rate_limited' : 'upstream_error';
    apiErr.status = res.status;
    throw apiErr;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw Object.assign(new Error('Gemini returned a non-JSON response body.'), { code: 'invalid_json' });
  }

  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = Array.isArray(parts)
    ? parts.filter(function (p) { return p && typeof p.text === 'string'; }).map(function (p) { return p.text; }).join('')
    : '';
  if (!text) {
    throw Object.assign(new Error('Gemini returned no content.'), { code: 'empty_response' });
  }
  return text;
}

export const GeminiProvider = {
  /**
   * Contextual grammar + clarity + style issues in one pass (combined for
   * cost reasons — see prompts.js). Prompts are shared verbatim with the
   * Anthropic provider. Returns the RAW parsed JSON from the model; callers
   * must run it through grammar-engine's normalizeAIIssues() before
   * trusting any offset.
   */
  async analyzeGrammar(text) {
    const raw = await callGemini(prompts.grammarPrompt(text), { maxTokens: 4000, temperature: 0.2, json: true });
    const parsed = parseJsonLoose(raw);
    if (!Array.isArray(parsed)) throw Object.assign(new Error('Model did not return a JSON array.'), { code: 'invalid_json' });
    return parsed;
  },

  /** Alias kept for interface parity; grammar and clarity share one call. */
  async analyzeClarity(text) {
    return GeminiProvider.analyzeGrammar(text);
  },

  async analyzeTone(text) {
    const raw = await callGemini(prompts.tonePrompt(text), { maxTokens: 800, temperature: 0.3, json: true });
    return parseJsonLoose(raw);
  },

  async rewriteText(text, style) {
    const raw = await callGemini(prompts.rewritePrompt(text, style), { maxTokens: 2000, temperature: 0.7 });
    return raw.trim();
  },

  async summarizeText(text) {
    const raw = await callGemini(prompts.summarizePrompt(text), { maxTokens: 600, temperature: 0.3 });
    return raw.trim();
  }
};
