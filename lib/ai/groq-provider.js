import * as prompts from './prompts.js';
import { parseJsonLoose } from './shared.js';

/**
 * Groq provider — OpenAI-compatible chat completions API.
 *
 * Uses the OFFICIAL Groq REST API directly with fetch
 * (https://api.groq.com/openai/v1/chat/completions) — the same zero-SDK
 * approach as the Gemini provider, so no new dependency is introduced.
 *
 * Auth: the key is sent in the `Authorization: Bearer <key>` HEADER (never
 * in the URL, so it cannot leak into access logs).
 *
 * Groq's API is fully OpenAI-compatible: request shape, response shape, and
 * error semantics follow the OpenAI chat completions convention.
 *
 * Never call this from client code — GROQ_API_KEY must stay server-side.
 */
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const TIMEOUT_MS = 30000;

function getApiKey() {
  return process.env.GROQ_API_KEY;
}

function toSafeBody(apiKey, bodyText) {
  if (!apiKey || !bodyText) return bodyText;
  return bodyText.split(apiKey).join('[REDACTED]');
}

/**
 * Sends one prompt to Groq via the OpenAI-compatible chat completions endpoint
 * and returns the raw text of the first choice. Never logs or embeds the API
 * key in thrown errors.
 */
async function callGroq(messages, options) {
  options = options || {};
  const apiKey = getApiKey();
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY is not set on the server.');
    err.code = 'missing_api_key';
    throw err;
  }
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;

  const body = {
    model: model,
    messages: messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens || 1000,
    stream: false
  };

  // gpt-oss models burn their token budget on hidden "reasoning" tokens first
  // (observed: ~3000 of 3600 tokens for one analyze call). Capping the effort
  // keeps grammar checks fast AND cuts total spend 4-5x against the free
  // tier's tokens-per-minute/day ceilings — the single biggest source of the
  // 429s this app was hitting. No effect on models without the parameter.
  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }

  if (options.json) {
    body.response_format = { type: 'json_object' };
  }

  let res;
  try {
    res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs || TIMEOUT_MS)
    });
  } catch (fetchErr) {
    const err = new Error(
      'Groq API request failed: ' +
        (fetchErr && fetchErr.name === 'TimeoutError'
          ? 'timed out after ' + (options.timeoutMs || TIMEOUT_MS) + 'ms'
          : 'network error')
    );
    err.code = 'upstream_error';
    throw err;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const apiErr = new Error('Groq API error ' + res.status + ': ' + toSafeBody(apiKey, bodyText).slice(0, 300));
    apiErr.code = res.status === 429 ? 'rate_limited' : 'upstream_error';
    apiErr.status = res.status;
    throw apiErr;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw Object.assign(new Error('Groq returned a non-JSON response body.'), { code: 'invalid_json' });
  }

  const choices = data && data.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw Object.assign(new Error('Groq returned no choices.'), { code: 'empty_response' });
  }

  const message = choices[0].message;
  if (!message || typeof message.content !== 'string') {
    throw Object.assign(new Error('Groq returned no content.'), { code: 'empty_response' });
  }

  return message.content.trim();
}

function buildMessages(promptText) {
  return [
    {
      role: 'system',
      content:
        'You are a writing assistant. Respond with ONLY the requested output — ' +
        'no preamble, no markdown fences unless the output is JSON, no commentary. ' +
        'If the user text is correct and there are no issues, return an empty array [].'
    },
    {
      role: 'user',
      content: promptText
    }
  ];
}

function extractIssues(raw) {
  let parsed;
  try {
    parsed = parseJsonLoose(raw);
  } catch (e) {
    throw Object.assign(new Error('Groq returned unparseable JSON.'), { code: 'invalid_json', raw });
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.issues)) {
      return parsed.issues;
    }
    if (Array.isArray(parsed.items)) {
      return parsed.items;
    }
    if (Array.isArray(parsed.results)) {
      return parsed.results;
    }
    const found = Object.values(parsed).find((v) => Array.isArray(v));
    if (Array.isArray(found)) {
      return found;
    }
  }

  throw Object.assign(new Error('Groq did not return a JSON array.'), { code: 'invalid_json', raw });
}

/**
 * Describe a raw model response's JSON shape WITHOUT echoing its contents —
 * issue text would leak the user's document into logs. Turns "invalid_json"
 * log lines into evidence you can actually root-cause.
 */
function describeShape(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 'empty';
  try {
    const parsed = parseJsonLoose(trimmed);
    if (Array.isArray(parsed)) return 'array(len=' + parsed.length + ')';
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed);
      const arrays = keys.filter((k) => Array.isArray(parsed[k])).map((k) => k + ':' + parsed[k].length);
      return 'object(keys=' + keys.slice(0, 8).join(',') + (arrays.length ? '; arrays=' + arrays.join(',') : '') + ')';
    }
    return typeof parsed;
  } catch (e) {
    return 'unparseable(len=' + trimmed.length + ')';
  }
}

/**
 * True for TRANSIENT MODEL FORMAT failures — a response we got but could not
 * use. These are worth exactly one retry. Never retried: 429, timeout, and
 * network errors, where a retry would double the TPM spend and worsen the
 * very rate limiting that caused them.
 */
function isRetryableFormatError(err) {
  if (!err) return false;
  if (err.code === 'invalid_json' || err.code === 'empty_response') return true;
  return err.status === 400 && String(err.message || '').indexOf('json_validate_failed') !== -1;
}

export const GroqProvider = {
  /**
   * Contextual grammar + clarity + style issues in one pass (combined for
   * cost reasons — see prompts.js). Returns the RAW parsed JSON from the
   * model; callers must run it through grammar-engine's normalizeAIIssues()
   * before trusting any offset.
   */
  async analyzeGrammar(text) {
    const prompt = prompts.grammarPrompt(text);
    const callOpts = { maxTokens: 4000, temperature: 0.2, json: true, reasoningEffort: 'low' };
    try {
      return extractIssues(await callGroq(buildMessages(prompt), callOpts));
    } catch (err) {
      if (!isRetryableFormatError(err)) throw err;
      console.error('[groq] unusable analyze response (' + describeShape(err.raw || '') + '), retrying once');
      return extractIssues(await callGroq(buildMessages(prompt), callOpts));
    }
  },

  /** Alias kept for interface parity; grammar and clarity share one call. */
  async analyzeClarity(text) {
    return GroqProvider.analyzeGrammar(text);
  },

  async analyzeTone(text) {
    const prompt = prompts.tonePrompt(text);
    const callOpts = { maxTokens: 800, temperature: 0.3, json: true, reasoningEffort: 'low' };
    let raw;
    try {
      raw = await callGroq(buildMessages(prompt), callOpts);
      return parseJsonLoose(raw);
    } catch (err) {
      if (!isRetryableFormatError(err) && !(err instanceof SyntaxError)) throw err;
      console.error('[groq] unusable tone response, retrying once');
      raw = await callGroq(buildMessages(prompt), callOpts);
      return parseJsonLoose(raw);
    }
    // Tone returns a JSON OBJECT ({primary, traits, note}), not an issues
    // array — parse it loosely so the object survives intact for the route's
    // zod validation. extractIssues here would return the traits ARRAY and
    // 502 every tone request.
  },

  async rewriteText(text, style) {
    const prompt = prompts.rewritePrompt(text, style);
    const raw = await callGroq(buildMessages(prompt), {
      maxTokens: 2000,
      temperature: 0.7,
      reasoningEffort: 'low'
    });
    return raw.trim();
  },

  async summarizeText(text) {
    const prompt = prompts.summarizePrompt(text);
    const raw = await callGroq(buildMessages(prompt), {
      maxTokens: 600,
      temperature: 0.3,
      reasoningEffort: 'low'
    });
    return raw.trim();
  }
};
