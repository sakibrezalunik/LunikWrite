import { GeminiProvider } from './gemini-provider.js';
import { GroqProvider } from './groq-provider.js';
import { callWithFallback } from './shared.js';

/**
 * AIProvider interface every provider must implement:
 *   analyzeGrammar(text: string): Promise<RawIssue[]>
 *   analyzeClarity(text: string): Promise<RawIssue[]>
 *   analyzeTone(text: string): Promise<{primary, traits, note}>
 *   rewriteText(text: string, style: string): Promise<string>
 *   summarizeText(text: string): Promise<string>
 *
 * Route handlers only ever call getProvider() — never a provider file
 * directly — so swapping providers is a change here, not a change everywhere
 * AI is called.
 *
 * Provider selection:
 *   AI_PROVIDER=groq       → Groq (cloud, primary)
 *   AI_PROVIDER=gemini     → Gemini (cloud, secondary)
 *
 * Fallback chain (no loop, no third provider): the provider named by
 * AI_PROVIDER is primary; the OTHER configured provider is the one and only
 * secondary, attempted once per request and only when the primary failed
 * transiently (429 / timeout / network / 5xx / unusable model output) — or
 * when the primary has no API key configured while the secondary does. The
 * secondary's own failure is thrown; the routes map it to the existing
 * standardized ai_unavailable response. There is no Ollama and no other
 * provider; both selected entries must be distinct, so Groq→Gemini→Groq
 * alternation is structurally impossible here.
 */
const PROVIDERS = {
  groq: GroqProvider,
  gemini: GeminiProvider
};

function buildChain() {
  const primary = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  if (!PROVIDERS[primary]) {
    throw new Error('Unknown AI_PROVIDER "' + primary + '". Implemented: "groq", "gemini".');
  }
  // Single fixed secondary, never the primary again: chain length is at
  // most 2 and entries are distinct by construction.
  const secondary = primary === 'groq' ? 'gemini' : 'groq';
  const chain = [{ name: primary, provider: PROVIDERS[primary] }];
  chain.push({ name: secondary, provider: PROVIDERS[secondary] });
  return chain;
}

/**
 * Returns an object exposing the AIProvider interface, but with every call
 * routed through the bounded fallback chain (Groq primary → Gemini backup
 * by default; AI_PROVIDER=gemini mirrors it). The shape stays exactly what
 * the route handlers already call — no route had to change.
 */
export function getProvider() {
  const chain = buildChain();
  const log = process.env.DIAGNOSTIC_LOG === '1' ? console.log : () => {};
  return {
    analyzeGrammar: (text) => callWithFallback(chain, 'analyzeGrammar', [text], process.env, log),
    analyzeClarity: (text) => callWithFallback(chain, 'analyzeClarity', [text], process.env, log),
    analyzeTone: (text) => callWithFallback(chain, 'analyzeTone', [text], process.env, log),
    rewriteText: (text, style) => callWithFallback(chain, 'rewriteText', [text, style], process.env, log),
    summarizeText: (text) => callWithFallback(chain, 'summarizeText', [text], process.env, log)
  };
}
