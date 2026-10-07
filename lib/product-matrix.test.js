/**
 * Lunik Write — product-behavior matrix.
 *
 * Encodes the QA acceptance criteria as tests: correct writing must never be
 * flagged (false positives are bugs), real errors must be caught with exact
 * offsets, malformed AI output must never reach the UI, and deterministic
 * features (stats, health, export filenames) must behave at every input size.
 *
 * Plain Node, zero dependencies:  node lib/product-matrix.test.js
 */
const assert = require('assert');
const GrammarEngine = require('./grammar-engine.js');
const WritingHealth = require('./writing-health.js');
const DesignSystem = require('./design-system.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS — ' + name);
    pass++;
  } catch (e) {
    console.log('FAIL — ' + name + '\n    ' + e.message);
    fail++;
  }
}
function applyIssue(text, issue) {
  return text.slice(0, issue.start) + issue.suggestion + text.slice(issue.end);
}
function find(text, variant, dict) {
  return GrammarEngine.findLocalIssues(text, variant || 'US', dict || []);
}
function normalize(text, raw, opts) {
  return GrammarEngine.normalizeAIIssues(text, raw, opts);
}

/* ============ 1. FALSE POSITIVES — correct writing must be left alone ============ */

const CORRECT_SENTENCES = [
  'She has been working here for five years.',
  'The quick brown fox jumps over the lazy dog.',
  'They’re going to their house over there, and it’s a lovely place.',
  'The weather will affect the harvest; the effect will be lasting.',
  'It’s better than the alternative, and then we’ll decide together.',
  'I received your email yesterday and replied immediately.',
  'In 2024, sales rose 12% to $3.5 million.',
  'Visit https://example.com/docs for details, or email support@example.com.',
  'A university, a European city, a one-time fee, and a euro — all take “a”.',
  'It costs an hour and an honest effort.'
];

test('correct simple prose produces zero local issues', () => {
  for (const s of CORRECT_SENTENCES) {
    const issues = find(s);
    assert.strictEqual(issues.length, 0, '"' + s + '" must not be flagged, got: ' +
      JSON.stringify(issues.map((i) => i.original + '→' + i.suggestion)));
  }
});

test('abbreviation periods do not trigger false capitalization flags (U.S., p.m., Dr., e.g., vs.)', () => {
  const cases = [
    'The U.S. economy grew steadily last year.',
    'The meeting starts at 3 p.m. tomorrow.',
    'We compared the results vs. the baseline.',
    'Items such as pens, e.g. ballpoints, were free.',
    'Dr. Adams will see you now.'
  ];
  for (const s of cases) {
    const caps = find(s).filter((i) => i.category === 'capitalization');
    assert.strictEqual(caps.length, 0, '"' + s + '" must not produce capitalization flags, got: ' +
      JSON.stringify(caps.map((i) => i.original)));
  }
});

test('true sentence starts after an abbreviation period ARE still flagged', () => {
  const issues = find('The U.S. economy grew. unemployment fell.');
  const caps = issues.filter((i) => i.category === 'capitalization' && i.original === 'u');
  assert.strictEqual(caps.length, 1, 'lowercase word after a real sentence end must still be flagged');
  assert.strictEqual(applyIssue('The U.S. economy grew. unemployment fell.', caps[0]),
    'The U.S. economy grew. Unemployment fell.');
});

test('a/an: consonant-sound acronyms (a US company, a UFO) are not flagged', () => {
  for (const s of ['She joined a US company.', 'He flew a UFO in the film.', 'Connect a USB cable.', 'Open a URL.']) {
    const arts = find(s).filter((i) => i.category === 'article');
    assert.strictEqual(arts.length, 0, '"' + s + '" must not be flagged, got: ' +
      JSON.stringify(arts.map((i) => i.original + '→' + i.suggestion)));
  }
});

test('genuine a/an errors are still caught', () => {
  for (const [s, fix] of [['She ate a apple.', 'an apple'], ['He waited a hour.', 'an hour'], ['a opportunity', 'an opportunity']]) {
    const arts = find(s).filter((i) => i.category === 'article');
    assert.ok(arts.length >= 1, '"' + s + '" must be flagged');
    assert.ok(arts.some((i) => applyIssue(s, i).includes(fix)), '"' + s + '" must fix to "' + fix + '"');
  }
});

/* ============ 2. DETECTION — real errors must be caught with exact offsets ============ */

test('spelling, agreement, articles, repetition, spacing all detected with exact offsets', () => {
  const cases = [
    ['I recieved the parcel.', 'misspelling', 'recieved', 'received'],
    ['She don\'t like coffee.', 'subject_verb_agreement', "She don't", "She doesn't"],
    ['She dont like coffee.', 'misspelling', 'dont', "don't"],
    ['He is a honest man.', 'article', 'a honest', 'an honest'],
    ['the the duplicates', 'repetition', 'the the', 'the'],
    ['Extra  spacing here.', 'spacing', '  ', ' '],
    ['Hello , world.', 'spacing', ' ,', ',']
  ];
  for (const [text, cat, orig, sug] of cases) {
    const issues = find(text);
    const hit = issues.find((i) => i.category === cat);
    assert.ok(hit, '"' + text + '" must produce a ' + cat + ' issue');
    assert.strictEqual(hit.original, orig, cat + ' original must be "' + orig + '"');
    assert.ok(hit.suggestion.includes(sug.replace('\\n', '\n')), cat + ' suggestion, got "' + hit.suggestion + '"');
    assert.strictEqual(text.slice(hit.start, hit.end), hit.original, 'offsets must exactly match original');
  }
});

test('personal dictionary suppresses matching spelling issues only', () => {
  const text = 'I recieved the parcel.';
  assert.strictEqual(find(text, 'US', ['recieved']).filter((i) => i.type === 'spelling').length, 0);
  assert.ok(find(text).some((i) => i.type === 'spelling'));
});

test('UK variant enforcement flags US spellings as style, not spelling', () => {
  const issues = find('My favorite color is gray.', 'UK', []);
  const v = issues.find((i) => i.original === 'favorite');
  assert.ok(v, 'favorite must be flagged under UK variant');
  assert.strictEqual(v.type, 'style');
  assert.strictEqual(v.suggestion, 'favourite');
});

/* ============ 3. AI ISSUE VALIDATION — malformed model output never reaches the UI ============ */

const GOOD = {
  type: 'grammar', category: 'agreement', severity: 'high',
  start: 4, end: 8, original: 'dont', suggestion: "don't",
  explanation: 'Apostrophe missing.', confidence: 0.95
};
const T = "She dont like coffee. Don't panic — it's fine.";
// index of "dont" in T:
GOOD.start = T.indexOf('dont');
GOOD.end = GOOD.start + 4;

test('valid AI issue passes through normalization unchanged in meaning', () => {
  const out = normalize(T, [GOOD]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].original, 'dont');
  assert.strictEqual(out[0].type, 'grammar');
  assert.strictEqual(T.slice(out[0].start, out[0].end), 'dont');
});

test('NaN, infinite, or out-of-range confidence is rejected, not rendered as NaN%', () => {
  for (const confidence of [NaN, Infinity, -Infinity, 1.5, -0.2]) {
    const out = normalize(T, [Object.assign({}, GOOD, { confidence })]);
    assert.strictEqual(out.length, 0, 'confidence ' + confidence + ' must be rejected');
  }
  assert.strictEqual(normalize(T, [Object.assign({}, GOOD, { confidence: undefined })]).length, 1,
    'missing confidence falls back to a safe default');
});

test('empty or whitespace-only suggestions are rejected (never a delete-the-text card)', () => {
  assert.strictEqual(normalize(T, [Object.assign({}, GOOD, { suggestion: '' })]).length, 0);
  assert.strictEqual(normalize(T, [Object.assign({}, GOOD, { suggestion: '   ' })]).length, 0);
});

test('suggestions identical to the original text are rejected (no-op cards)', () => {
  assert.strictEqual(normalize(T, [Object.assign({}, GOOD, { suggestion: 'dont' })]).length, 0);
});

test('impossible ranges (inverted, negative, past EOF) are never used as-is', () => {
  // inverted range with recoverable original: re-anchored, never mis-highlighted
  const inv = normalize(T, [Object.assign({}, GOOD, { start: 900, end: 3 })]);
  assert.strictEqual(inv.length, 1);
  assert.strictEqual(T.slice(inv[0].start, inv[0].end), 'dont');
  // unfindable original with garbage offsets: dropped entirely
  assert.strictEqual(normalize(T, [Object.assign({}, GOOD, { start: 900, end: 3, original: 'zzz-not-there' })]).length, 0);
  // negative start, unfindable: dropped
  assert.strictEqual(normalize(T, [Object.assign({}, GOOD, { start: -5, end: -1, original: 'nope' })]).length, 0);
});

test('non-object and offset-less entries are silently dropped', () => {
  const out = normalize(T, [null, 42, 'text', { type: 'grammar' }, GOOD]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].original, 'dont');
});

test('unknown types coerce to grammar; known types survive for category tabs', () => {
  const out = normalize(T, [
    Object.assign({}, GOOD, { type: 'tone_problem' }),
    Object.assign({}, GOOD, { type: 'spelling' }),
    Object.assign({}, GOOD, { type: 'punctuation' }),
    Object.assign({}, GOOD, { type: 'clarity' }),
    Object.assign({}, GOOD, { type: 'style' })
  ]);
  assert.deepStrictEqual(out.map((i) => i.type),
    ['grammar', 'spelling', 'punctuation', 'clarity', 'style']);
});

test('empty array, non-array, and missing input all yield zero issues (never throw)', () => {
  assert.deepStrictEqual(normalize(T, []), []);
  assert.deepStrictEqual(normalize(T, undefined), []);
  assert.deepStrictEqual(normalize(T, null), []);
  assert.deepStrictEqual(normalize(T, { issues: [] }), []);
  assert.deepStrictEqual(normalize(T, 'not an array'), []);
});

/* ============ 4. MERGE + DEDUPE ============ */

test('merge sorts by offset and never produces out-of-order issues', () => {
  const local = find('I recieved teh parcel and teh letter.');
  const ai = normalize('I recieved teh parcel and teh letter.', [
    { type: 'spelling', category: 'x', severity: 'low', start: 0, end: 1, original: 'I', suggestion: 'We', explanation: '', confidence: 0.8 }
  ]);
  const merged = GrammarEngine.mergeIssues(local, ai);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i].start >= merged[i - 1].start, 'must be offset-sorted');
});

test('AI and local flagging the same span+type+fix collapse to one card', () => {
  const text = 'I recieved the parcel.';
  const local = find(text);
  const dup = local.find((i) => i.category === 'misspelling');
  const ai = normalize(text, [{
    type: 'spelling', category: 'misspelling', severity: 'high',
    start: dup.start, end: dup.end, original: dup.original, suggestion: 'received',
    explanation: '', confidence: 0.95
  }]);
  const merged = GrammarEngine.mergeIssues(local, ai);
  assert.strictEqual(merged.length, local.length, 'exact duplicate must collapse');
});

/* ============ 5. STATS + READABILITY ============ */

test('unterminated final sentence still counts (drafts rarely end with punctuation)', () => {
  const stats = GrammarEngine.computeStats('Hello there. And goodbye');
  assert.strictEqual(stats.sentences, 2, 'two sentences even without a final period');
  const stats2 = GrammarEngine.computeStats('one two three');
  assert.strictEqual(stats2.sentences, 1);
  assert.strictEqual(stats2.wordCount, 3);
});

test('stats stay sane for empty and whitespace documents', () => {
  for (const t of ['', '   ', '\n\n']) {
    const s = GrammarEngine.computeStats(t);
    assert.strictEqual(s.wordCount, 0);
    assert.strictEqual(s.sentences, 0);
    assert.strictEqual(s.readingTime, 0);
  }
});

test('readability: simple text reads easier than academic text', () => {
  const simple = GrammarEngine.computeStats('The cat sat on the mat. It was warm. We were glad.');
  const hard = GrammarEngine.computeStats(
    'Notwithstanding the aforementioned considerations, the implementation of comprehensive interdisciplinary ' +
    'methodologies necessitates substantial organizational restructuring throughout contemporary institutional frameworks.'
  );
  assert.ok(simple.flesch > hard.flesch);
  assert.ok(simple.complexPct < hard.complexPct);
  assert.ok(GrammarEngine.readabilityLabel(simple.flesch) !== GrammarEngine.readabilityLabel(hard.flesch));
});

/* ============ 6. WRITING HEALTH ============ */

test('health handles tiny documents without weird scores', () => {
  const h = WritingHealth.computeWritingHealth('Hi.', []);
  assert.ok(h, 'tiny doc scores');
  assert.ok(h.overall >= 0 && h.overall <= 100);
  const h2 = WritingHealth.computeWritingHealth('One single sentence.', [
    { severity: 'high' }, { severity: 'high' }, { severity: 'high' }
  ]);
  assert.ok(h2.overall < 100, 'issues must lower a tiny-doc score');
});

test('health never returns NaN for scorable text; wordless text scores nothing', () => {
  assert.strictEqual(WritingHealth.computeWritingHealth('!!!', []), null,
    'no words → nothing to score (same as empty doc)');
  const texts = ['a', 'a.', 'One two. Three four five six seven eight nine ten eleven twelve.', '123 456'];
  for (const t of texts) {
    const h = WritingHealth.computeWritingHealth(t, [{ severity: 'medium' }]);
    assert.ok(h, 'health for "' + t + '"');
    assert.ok(Number.isFinite(h.overall), 'overall must be finite for "' + t + '"');
    for (const m of h.metrics) assert.ok(Number.isFinite(m.score), m.key + ' must be finite for "' + t + '"');
  }
});

/* ============ 7. EXPORT FILENAME SANITIZATION ============ */

test('export filenames keep hyphens, convert spaces to hyphens, drop unsafe chars', () => {
  assert.strictEqual(DesignSystem.sanitizedFilename('My Draft: 2!'), 'my-draft-2');
  assert.strictEqual(DesignSystem.sanitizedFilename('My-Draft notes'), 'my-draft-notes');
  assert.strictEqual(DesignSystem.sanitizedFilename('../../etc/passwd'), 'etcpasswd');
  assert.strictEqual(DesignSystem.sanitizedFilename(''), 'document');
  assert.strictEqual(DesignSystem.sanitizedFilename(null), 'document');
  assert.strictEqual(DesignSystem.sanitizedFilename('   '), 'document');
  assert.strictEqual(DesignSystem.sanitizedFilename('Résumé — final'), 'rsum-final'); // ASCII-only by design
});

/* ============ 8. ISSUE TYPE / CATEGORY INTEGRITY ============ */

test('every local issue type is one of the five UI category tabs', () => {
  const VALID = ['grammar', 'spelling', 'punctuation', 'clarity', 'style'];
  const texts = [
    'I recieved the parcel.  She dont  care , and the the words pile up. A apple a hour a US thing.',
    'My favourite colour is grey.  Wait ... what ?'
  ];
  for (const t of texts) {
    for (const i of find(t)) {
      assert.ok(VALID.indexOf(i.type) !== -1, 'issue type "' + i.type + '" has no tab; UI would hide it');
      assert.ok(i.severity === 'high' || i.severity === 'medium' || i.severity === 'low', 'bad severity');
      assert.ok(typeof i.confidence === 'number' && i.confidence >= 0 && i.confidence <= 1, 'bad confidence');
      assert.notStrictEqual(i.suggestion, i.original, 'suggestion must differ from original');
      assert.ok(i.suggestion.length > 0, 'suggestion must be non-empty');
    }
  }
});

console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
