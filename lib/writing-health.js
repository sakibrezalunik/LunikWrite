/**
 * Lunik Write — Writing Health.
 *
 * Deterministic, zero-dependency document-level scoring. Everything here is
 * computed from the text itself (and optionally the merged issue list), so
 * the same document always produces the same score on every device. No AI,
 * no network, no randomness — see lib/writing-health.test.js.
 *
 * UMD like grammar-engine.js so the exact same file can serve the web app,
 * a serverless function, React Native, or a plain <script> tag.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./grammar-engine.js'));
  } else if (typeof define === 'function' && define.amd) {
    define(['./grammar-engine.js'], factory);
  } else {
    root.LunikWritingHealth = factory(root.LunikGrammarEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (GrammarEngine) {
  'use strict';

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function sentenceWordCounts(text) {
    var parts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    var counts = [];
    parts.forEach(function (s) {
      var w = s.match(/[A-Za-z0-9']+/g);
      if (w && w.length) counts.push(w.length);
    });
    return counts;
  }

  // Severity-weighted issue density: a "high" issue costs more than a nitpick.
  var SEVERITY_WEIGHT = { high: 1, medium: 0.6, low: 0.3 };

  function correctnessScore(wordCount, issues) {
    if (!wordCount) return null;
    var weighted = 0;
    (issues || []).forEach(function (i) {
      var w = i && SEVERITY_WEIGHT[i.severity];
      weighted += typeof w === 'number' ? w : 0.6;
    });
    var per100 = (weighted / wordCount) * 100;
    // 2 high-severity issues per 100 words → 84; 10+ per 100 → 0.
    return clamp(100 - per100 * 8, 0, 100);
  }

  function concisenessScore(avgSentLen) {
    // 100 at 14 words/sentence or fewer, linearly down to 0 at 35.
    return clamp(100 - (avgSentLen - 14) * (100 / 21), 0, 100);
  }

  function varietyScore(text) {
    var counts = sentenceWordCounts(text);
    if (counts.length < 2) return null; // honest: variety needs 2+ sentences
    var mean = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
    if (mean === 0) return null;
    var variance = counts.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / counts.length;
    var cv = Math.sqrt(variance) / mean; // coefficient of variation
    // Uniform sentence lengths (cv 0) → 0; healthy spread (cv ≥ 0.5) → 100.
    return clamp((cv / 0.5) * 100, 0, 100);
  }

  function clarityScore(flesch) {
    return clamp(flesch, 0, 100);
  }

  /**
   * @param {string} text
   * @param {Array<{severity?: string}>} [issues] - merged issue list (local + AI).
   * @returns {{overall: number, label: string, metrics: Array<{key: string, label: string, score: number, detail: string}>}|null}
   *   null for an empty document (nothing to score yet).
   */
  function computeWritingHealth(text, issues) {
    var stats = GrammarEngine.computeStats(text || '');
    if (!stats || stats.wordCount === 0) return null;

    var issueCount = (issues || []).length;
    var sentenceCounts = sentenceWordCounts(text || '');

    var metrics = [];
    var totalWeight = 0;
    var weightedSum = 0;

    function addMetric(key, label, weight, score, detail) {
      if (score === null || typeof score !== 'number' || isNaN(score)) return;
      metrics.push({ key: key, label: label, score: Math.round(score), detail: detail || '' });
      weightedSum += score * weight;
      totalWeight += weight;
    }

    addMetric('clarity', 'Clarity', 0.3, clarityScore(stats.flesch), GrammarEngine.readabilityLabel(stats.flesch));
    addMetric(
      'correctness', 'Correctness', 0.3, correctnessScore(stats.wordCount, issues),
      issueCount === 0 ? 'No issues found in this document' : issueCount + (issueCount === 1 ? ' issue found' : ' issues found')
    );
    addMetric(
      'conciseness', 'Conciseness', 0.2, concisenessScore(stats.avgSentLen),
      Math.round(stats.avgSentLen * 10) / 10 + ' words per sentence'
    );
    addMetric('variety', 'Variety', 0.2, varietyScore(text || ''), sentenceCounts.length + ' sentences');

    if (!totalWeight) return null;
    var overall = Math.round(weightedSum / totalWeight);
    var label = overall >= 85 ? 'Strong' : overall >= 70 ? 'Solid' : overall >= 50 ? 'Fair' : 'Needs work';
    return { overall: overall, label: label, metrics: metrics };
  }

  return { computeWritingHealth: computeWritingHealth };
});
