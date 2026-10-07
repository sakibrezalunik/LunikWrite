import { GeminiProvider } from './gemini-provider.js';
import { GroqProvider } from './groq-provider.js';

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
 * There is no local/Ollama provider in this project. All AI calls go through
 * a cloud provider, so Lunik Write works on Vercel and when the user's PC is
 * shut down. No local AI server, no localhost:11434, no Ollama dependency.
 */
export function getProvider() {
  const name = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  switch (name) {
    case 'groq':
      return GroqProvider;
    case 'gemini':
      return GeminiProvider;
    default:
      throw new Error('Unknown AI_PROVIDER "' + name + '". Implemented: "groq", "gemini".');
  }
}
