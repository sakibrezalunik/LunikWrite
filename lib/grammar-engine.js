/**
 * Lunik Write — core rules engine.
 *
 * Pure JavaScript, zero dependencies, no DOM and no Node-only APIs. This is
 * the exact local-checking logic used by the web prototype, extracted so it
 * can be imported identically from:
 *   - a bundled web app (webpack/vite/Next.js client code)
 *   - a Vercel serverless function (Node, via require())
 *   - a React Native / Expo app (Metro bundler supports require() natively)
 *   - a plain <script src="grammar-engine.js"> tag (exposes window.LunikGrammarEngine)
 *
 * Nothing in this file calls a network API. AI-powered contextual checks are
 * a separate concern — see lib/ai/ — this module only ever returns issues it
 * can find with dictionaries and regular expressions, plus helpers for
 * merging those with AI-sourced issues and validating AI output offsets.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.LunikGrammarEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- Dictionaries ---------------- */

  var DICTIONARY = {
    "recieve":"receive","recieved":"received","recieving":"receiving",
    "teh":"the","seperate":"separate","seperated":"separated","seperately":"separately",
    "definately":"definitely","occured":"occurred","occuring":"occurring",
    "wich":"which","thier":"their","untill":"until","becuase":"because",
    "neccessary":"necessary","unnecesary":"unnecessary","accomodate":"accommodate",
    "publically":"publicly","wierd":"weird","goverment":"government",
    "arguement":"argument","enviroment":"environment","existance":"existence",
    "independant":"independent","priviledge":"privilege","embarass":"embarrass",
    "calender":"calendar","concious":"conscious","dilema":"dilemma",
    "foriegn":"foreign","gaurd":"guard","harrass":"harass","mispelled":"misspelled",
    "immediatly":"immediately","knowlege":"knowledge","liesure":"leisure",
    "maintainance":"maintenance","noticable":"noticeable","occassion":"occasion",
    "persistant":"persistent","posession":"possession","questionaire":"questionnaire",
    "recomend":"recommend","recomended":"recommended","rythm":"rhythm",
    "succesful":"successful","successfull":"successful","tommorow":"tomorrow",
    "unforseen":"unforeseen","vaccuum":"vacuum","wellfare":"welfare","alot":"a lot",
    "adress":"address","apparant":"apparent","begining":"beginning","beleive":"believe",
    "cemetary":"cemetery","collegue":"colleague","commitee":"committee","concensus":"consensus",
    // Unambiguous missing-apostrophe typos (never real words, unlike "wont"
    // or "its"): "dont" is always "don't".
    "dont":"don't","doesnt":"doesn't","didnt":"didn't","isnt":"isn't","arent":"aren't",
    "werent":"weren't","wasnt":"wasn't","havent":"haven't","hasnt":"hasn't","hadnt":"hadn't",
    "wouldnt":"wouldn't","couldnt":"couldn't","shouldnt":"shouldn't","cant":"can't",
    "theyre":"they're","youre":"you're","youve":"you've","theyve":"they've","weve":"we've",
    "ive":"I've","thats":"that's","whats":"what's","heres":"here's","theres":"there's"
  };

  var VARIANT_PAIRS = [
    ["color","colour"],["colors","colours"],["colored","coloured"],["coloring","colouring"],
    ["favorite","favourite"],["favorites","favourites"],["center","centre"],["centers","centres"],
    ["organize","organise"],["organizes","organises"],["organized","organised"],["organizing","organising"],
    ["analyze","analyse"],["analyzes","analyses"],["analyzed","analysed"],["analyzing","analysing"],
    ["behavior","behaviour"],["behaviors","behaviours"],["traveling","travelling"],["traveled","travelled"],
    ["gray","grey"],["catalog","catalogue"],["defense","defence"],["realize","realise"],["realized","realised"],
    ["honor","honour"],["honors","honours"],["labor","labour"],["neighbor","neighbour"],["neighbors","neighbours"],
    ["apologize","apologise"],["recognize","recognise"],["theater","theatre"]
  ];
  var US_TO_UK = {}, UK_TO_US = {};
  VARIANT_PAIRS.forEach(function (p) { US_TO_UK[p[0]] = p[1]; UK_TO_US[p[1]] = p[0]; });

  var AAN_EXCEPTIONS = ["university","universities","unicorn","unicorns","one","ones","once",
    "useful","user","users","uniform","uniforms","unique","euro","euros","ewe","ewes","european",
    "ubiquitous","euphemism","euphemisms","eulogy","eucalyptus","euphoria",
    // U-acronyms are spoken with a consonant "you" sound: "a US company",
    // "a UFO" are correct — flagging them manufactures errors.
    "us","uk","un","uno","unesco","url","uri","usa","usb","utc","ups","uv","ui","ux",
    "ufo","uid","uuid"];
  // Words that start with a consonant LETTER but a vowel SOUND (silent h) — "an honest man" is
  // correct despite "honest" starting with "h". The reverse of AAN_EXCEPTIONS above.
  var SILENT_H_WORDS = ["honest","honestly","honesty","honor","honors","honored","honorable",
    "honorably","honorary","honour","honours","honoured","honourable","hour","hours","hourly",
    "heir","heirs","heiress","heirloom","heirlooms"];

  /* ---------------- Helpers ---------------- */

  function preserveCase(sample, word) {
    if (sample.length && sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase()) {
      return word[0].toUpperCase() + word.slice(1);
    }
    return word;
  }

  function rangesOverlap(a, b) { return a.start < b.end && b.start < a.end; }

  // Issue types the client's category tabs (ISSUE_TYPES in design-system.js) know
  // how to render. AI output naming one of these keeps it; anything else is
  // coerced to 'grammar' — the closest general bucket — never silently to
  // 'style', so AI spelling/punctuation findings still reach their own tabs.
  var VALID_TYPES = { grammar: 1, spelling: 1, punctuation: 1, clarity: 1, style: 1 };

  /* ---------------- Local rule engine ---------------- */

  /**
   * Scan text for spelling, spacing, punctuation, and simple grammar issues.
   * @param {string} text
   * @param {'US'|'UK'} [variant] - which spelling variant to enforce. Defaults to 'US'.
   * @param {string[]} [personalDict] - lowercase words to never flag as spelling issues.
   * @returns {object[]} issues, each {id, source:'local', type, category, severity, start, end, original, suggestion, explanation, confidence}
   */
  function findLocalIssues(text, variant, personalDict) {
    variant = variant === 'UK' ? 'UK' : 'US';
    personalDict = personalDict || [];
    var issues = [];
    var idc = 0;
    function push(o) { o.id = 'local-' + (idc++); o.source = 'local'; issues.push(o); }

    var wordRe = /[A-Za-z']+/g, m;
    while ((m = wordRe.exec(text))) {
      var w = m[0], lw = w.toLowerCase();
      if (DICTIONARY[lw] && personalDict.indexOf(lw) === -1) {
        var sug = preserveCase(w, DICTIONARY[lw]);
        push({type:'spelling', category:'misspelling', severity:'high',
          start:m.index, end:m.index + w.length, original:w, suggestion:sug,
          explanation:'"' + w + '" is commonly misspelled; did you mean "' + sug + '"?', confidence:0.97});
      }
    }

    var variantMap = variant === 'US' ? UK_TO_US : US_TO_UK;
    var vRe = /[A-Za-z]+/g;
    while ((m = vRe.exec(text))) {
      var vw = m[0], vlw = vw.toLowerCase();
      if (variantMap[vlw] && personalDict.indexOf(vlw) === -1) {
        var vsug = preserveCase(vw, variantMap[vlw]);
        push({type:'style', category:'spelling_variant', severity:'low',
          start:m.index, end:m.index + vw.length, original:vw, suggestion:vsug,
          explanation:'Use ' + variant + ' spelling for consistency.', confidence:0.8});
      }
    }

    var dsRe = /[ \t]{2,}/g;
    while ((m = dsRe.exec(text))) {
      push({type:'punctuation', category:'spacing', severity:'medium',
        start:m.index, end:m.index + m[0].length, original:m[0], suggestion:' ',
        explanation:'Extra spaces between words.', confidence:0.95});
    }

    var rwRe = /\b([A-Za-z]+)([ \t]+)\1\b/gi;
    while ((m = rwRe.exec(text))) {
      push({type:'grammar', category:'repetition', severity:'high',
        start:m.index, end:m.index + m[0].length, original:m[0], suggestion:m[1],
        explanation:'"' + m[1] + '" appears to be repeated.', confidence:0.9});
    }

    var spRe = /[ \t]+([,.;:!?])/g;
    while ((m = spRe.exec(text))) {
      push({type:'punctuation', category:'spacing', severity:'medium',
        start:m.index, end:m.index + m[0].length, original:m[0], suggestion:m[1],
        explanation:'Remove the space before punctuation.', confidence:0.9});
    }

    var dontRe = /\b(She|he|It|she|He|it)([ \t]+)don't\b/g;
    while ((m = dontRe.exec(text))) {
      var full = m[0];
      push({type:'grammar', category:'subject_verb_agreement', severity:'high',
        start:m.index, end:m.index + full.length, original:full,
        suggestion: m[1] + m[2] + 'doesn\'t',
        explanation:'Use "doesn\'t" with the singular subject "' + m[1] + '".', confidence:0.95});
    }

    var aanRe = /\b([Aa])([ \t]+)([AEIOUaeiou]\w*)/g;
    while ((m = aanRe.exec(text))) {
      var aword = m[3].toLowerCase();
      if (AAN_EXCEPTIONS.indexOf(aword) !== -1) continue;
      var afull = m[0];
      push({type:'grammar', category:'article', severity:'medium',
        start:m.index, end:m.index + afull.length, original:afull,
        suggestion:(m[1] === 'A' ? 'An' : 'an') + m[2] + m[3],
        explanation:'Use "an" before a word that starts with a vowel sound.', confidence:0.85});
    }

  var hRe = /\b([Aa])([ \t]+)([Hh]\w*)/g;
  while ((m = hRe.exec(text))) {
    var hword = m[3].toLowerCase();
    if (SILENT_H_WORDS.indexOf(hword) === -1) continue;
    var hfull = m[0];
    push({type:'grammar', category:'article', severity:'medium',
      start:m.index, end:m.index + hfull.length, original:hfull,
      suggestion:(m[1] === 'A' ? 'An' : 'an') + m[2] + m[3],
      explanation:'Use "an" before "' + m[3] + '" \u2014 the h is silent.', confidence:0.9});
  }

  // Tokens whose trailing period is part of the token itself ("U.S.", "Dr.",
  // "e.g.", "p.m.") — the next word is correctly lowercase, so a capitalization
  // flag there would manufacture an error in correct writing.
  var ABBREVIATIONS = ["dr","mr","mrs","ms","st","vs","etc","eg","ie","inc","ltd","jr","sr",
    "prof","ave","fig","no","approx","dept","univ","est","cf","al","ca","vol","ed"];

  var capRe = /([.!?]["'\u201d\)\]]?[ \t]+)([a-z])/g;
    while ((m = capRe.exec(text))) {
      // Is the terminator part of an abbreviation ("U.S", "Dr", "p.m", "e.g")
      // rather than a sentence end? Look at the token just before it.
      var before = text.slice(0, m.index);
      var token = (before.match(/[A-Za-z][A-Za-z.]*$/) || [''])[0];
      var bare = token.replace(/\./g, '').toLowerCase();
      if (ABBREVIATIONS.indexOf(bare) !== -1) continue;
      if (/[a-z]\.[a-z]$/i.test(token)) continue; // mid-abbreviation period, e.g. "U.S" or "p.m"
      var cstart = m.index + m[1].length;
      push({type:'grammar', category:'capitalization', severity:'low',
        start:cstart, end:cstart + 1, original:m[2], suggestion:m[2].toUpperCase(),
        explanation:'Capitalize the first letter of a new sentence.', confidence:0.7});
    }

    return issues;
  }

  /**
   * Combine local-engine issues with AI-sourced issues, dropping any AI
   * issue that overlaps a range the local engine already flagged (the local
   * engine is cheaper and just as reliable for the things it catches).
   */
  function mergeIssues(local, ai) {
    var merged = local.slice();
    (ai || []).forEach(function (a) {
      // Drop only true duplicates: same span, same type AND the same suggested
      // replacement. An AI issue overlapping a local flag but offering a
      // different suggestion is a second opinion the user should see.
      var dup = merged.some(function (l) {
        return rangesOverlap(l, a) && l.type === a.type &&
          String(l.suggestion) === String(a.suggestion);
      });
      if (!dup) merged.push(a);
    });
    merged.sort(function (x, y) { return x.start - y.start; });
    return merged;
  }

  /**
   * Validate raw AI-returned issues against the actual text and normalize
   * them into the same shape the local engine produces. This is the single
   * place offset-safety is enforced — call it wherever AI output is first
   * received (currently: the /api/analyze route handler), so every client
   * (web, iOS, Android) gets pre-validated issues and never has to trust a
   * model's offsets on its own.
   *
   * @param {string} text - the exact text the AI was given (post any truncation).
   * @param {any} rawIssues - whatever the model returned, parsed from JSON.
   * @param {{minConfidence?: number}} [opts]
   * @returns {object[]} issues in the same shape as findLocalIssues(), source:'ai'
   */
  function normalizeAIIssues(text, rawIssues, opts) {
    opts = opts || {};
    var minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.7;
    var out = [];
    if (!Array.isArray(rawIssues)) return out;
    var idc = 0;
    rawIssues.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var start = item.start, end = item.end, original = item.original;
      var direct = typeof start === 'number' && typeof end === 'number' &&
        isFinite(start) && isFinite(end) &&
        start >= 0 && end <= text.length && start < end &&
        text.slice(start, end) === original;
      if (!direct) {
        // Offsets untrusted: re-anchor from the quoted original when (and only
        // when) that yields a range provably inside the text.
        if (typeof original !== 'string' || !original) return;
        var idx = text.indexOf(original);
        if (idx === -1) return; // can't safely locate it — drop rather than mis-highlight
        start = idx; end = idx + original.length;
      }
      var confidence;
      if (typeof item.confidence === 'number' && isFinite(item.confidence) &&
          item.confidence >= 0 && item.confidence <= 1) {
        confidence = item.confidence;
      } else if (item.confidence === undefined || item.confidence === null) {
        confidence = 0.75; // field omitted — assume a safe default
      } else {
        return; // NaN / out-of-range confidence is bad data, not low confidence
      }
      if (confidence < minConfidence) return;
      var effectiveOriginal = text.slice(start, end);
      var suggestion = typeof item.suggestion === 'string' ? item.suggestion : '';
      // An empty suggestion would render an Accept button that DELETES the
      // user's text; a suggestion equal to the original is a no-op card.
      // Both are invalid output — reject rather than render.
      if (!suggestion.trim()) return;
      if (suggestion === effectiveOriginal) return;
      var type = VALID_TYPES[item.type] ? item.type : 'grammar';
      out.push({
        id: 'ai-' + (idc++),
        source: 'ai',
        type: type,
        category: typeof item.category === 'string' && item.category ? item.category : 'general',
        severity: item.severity === 'high' || item.severity === 'low' ? item.severity : 'medium',
        start: start, end: end,
        original: effectiveOriginal,
        suggestion: suggestion,
        explanation: typeof item.explanation === 'string' ? item.explanation : '',
        confidence: confidence
      });
    });
    return out;
  }

  /* ---------------- Readability ---------------- */

  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!word) return 0;
    if (word.length <= 3) return 1;
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');
    var mm = word.match(/[aeiouy]{1,2}/g);
    return mm ? mm.length : 1;
  }

  function computeStats(text) {
    var words = text.match(/[A-Za-z0-9']+/g) || [];
    var wordCount = words.length;
    var charCount = text.length;
    // Count sentences the same way writing-health.js does: a chunk of text
    // ending in a terminator, plus a final unterminated chunk. Drafts rarely
    // end with punctuation, and the last sentence still exists.
    var sentenceParts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    var sentences = 0;
    sentenceParts.forEach(function (s) {
      if ((s.match(/[A-Za-z0-9']+/g) || []).length > 0) sentences++;
    });
    var syllables = 0, complexWords = 0;
    words.forEach(function (w) {
      var s = countSyllables(w);
      syllables += s;
      if (s >= 3) complexWords++;
    });
    var readingTime = wordCount > 0 ? Math.max(1, Math.round(wordCount / 200)) : 0;
    var flesch = 0, fk = 0;
    if (wordCount > 0 && sentences > 0) {
      var wps = wordCount / sentences;
      var spw = syllables / wordCount;
      flesch = 206.835 - 1.015 * wps - 84.6 * spw;
      fk = 0.39 * wps + 11.8 * spw - 15.59;
    }
    return {
      wordCount: wordCount, charCount: charCount, sentences: sentences,
      readingTime: readingTime, flesch: flesch, fk: Math.max(0, fk),
      avgSentLen: sentences > 0 ? wordCount / sentences : 0,
      avgWordLen: wordCount > 0 ? words.join('').length / wordCount : 0,
      complexPct: wordCount > 0 ? (complexWords / wordCount) * 100 : 0
    };
  }

  function readabilityLabel(score) {
    if (score >= 90) return 'Very easy to read';
    if (score >= 70) return 'Easy to read';
    if (score >= 60) return 'Fairly easy to read';
    if (score >= 50) return 'Standard, plain writing';
    if (score >= 30) return 'Fairly difficult to read';
    if (score > 0) return 'Difficult to read';
    return 'Very difficult to read';
  }

  return {
    DICTIONARY: DICTIONARY,
    VARIANT_PAIRS: VARIANT_PAIRS,
    findLocalIssues: findLocalIssues,
    mergeIssues: mergeIssues,
    normalizeAIIssues: normalizeAIIssues,
    rangesOverlap: rangesOverlap,
    computeStats: computeStats,
    countSyllables: countSyllables,
    readabilityLabel: readabilityLabel
  };
});
