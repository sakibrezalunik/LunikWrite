/**
 * Every prompt Lunik Write sends to a model lives here, and only here.
 * Server-side only — clients (web, iOS, Android) never build a prompt or
 * see Anthropic's response format directly; they call our own API routes
 * and get back pre-validated JSON (see lib/grammar-engine.js's
 * normalizeAIIssues, and the route handlers under app/api/).
 */

export const MAX_CHARS = 6000;

export function clip(text) {
  return typeof text === 'string' && text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

export function grammarPrompt(text) {
  const t = clip(text);
  return (
    'You are the contextual layer of a writing assistant. A local rule engine already fixes ' +
    'simple misspellings, double spaces, repeated words, and spacing before punctuation \u2014 skip those entirely.\n\n' +
    'Find remaining CONTEXTUAL grammar problems (verb tense, verb form, agreement, prepositions, ' +
    'pronouns, missing or extra words, sentence structure), SPELLING problems where a correctly ' +
    'spelled word is wrong in context (their/there, affect/effect, its/it\u2019s), PUNCTUATION problems ' +
    '(missing commas, run-on sentences, apostrophes), CLARITY problems (wordiness, ambiguity, ' +
    'passive voice, weak transitions), and STYLE problems only when clearly worth flagging.\n\n' +
    'Reply with ONLY a JSON array (no prose, no markdown fences, no commentary). Each element:\n' +
    '{"type":"grammar"|"spelling"|"punctuation"|"clarity"|"style","category":"short_snake_case_label","severity":"low"|"medium"|"high",' +
    '"start":<int>,"end":<int>,"original":"<exact substring of TEXT>","suggestion":"<replacement text>",' +
    '"explanation":"<one short sentence>","confidence":<0 to 1>}\n\n' +
    'Rules: start/end are 0-indexed character offsets into TEXT using JavaScript string indexing. ' +
    '"original" must exactly equal TEXT.slice(start, end). Only include issues with confidence 0.7 or higher. ' +
    'Never invent problems in a correct sentence. Return [] if there is nothing left to flag.\n\n' +
    'TEXT:\n"""\n' + t + '\n"""'
  );
}

export function tonePrompt(text) {
  const t = clip(text);
  return (
    'Estimate the tone of the following text for a writer. Reply with ONLY JSON of the shape ' +
    '{"primary":"<one or two word summary>","traits":[{"name":"<Formal|Casual|Confident|Friendly|Direct|' +
    'Polite|Academic|Persuasive|Neutral \u2014 pick up to 5 that apply>","score":<0-100>}],' +
    '"note":"<one short sentence, phrased as an estimate, not a certainty>"}.\n\n' +
    'TEXT:\n"""\n' + t + '\n"""'
  );
}

export const STYLE_LABELS = {
  improve: 'Improve the clarity and flow of this text without changing its meaning.',
  shorten: 'Make this text more concise while keeping the same meaning.',
  expand: 'Expand this text with more useful detail while keeping the same meaning.',
  simplify: 'Rewrite this text in simpler, plainer language.',
  formal: 'Rewrite this text in a more formal, professional tone.',
  casual: 'Rewrite this text in a warmer, more casual tone.',
  persuasive: 'Rewrite this text to be more persuasive and confident.'
};

export function rewritePrompt(text, style) {
  const instruction = STYLE_LABELS[style] || STYLE_LABELS.improve;
  // Rewrite targets are a user-selected snippet, not a whole document — no clipping here,
  // but the route handler still enforces a hard length cap on the request body.
  return (
    instruction + ' Reply with ONLY the rewritten text \u2014 no quotes, no preamble, no explanation.\n\n' +
    'TEXT:\n"""\n' + text + '\n"""'
  );
}

export function summarizePrompt(text) {
  const t = clip(text);
  return (
    'Summarize the following text in 2-3 sentences, in plain language, preserving the key points and ' +
    'the author\'s intent. Reply with ONLY the summary \u2014 no preamble, no labels.\n\n' +
    'TEXT:\n"""\n' + t + '\n"""'
  );
}
