(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LunikApiClient = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * A tiny fetch wrapper for Lunik Write's API routes. Works unchanged in:
   *   - a web app (Vercel-hosted, same origin — pass baseUrl: '')
   *   - a React Native / Expo app (pass baseUrl: 'https://your-app.vercel.app')
   *
   * Every method resolves normally on success and throws an Error with a
   * `.code` (matching the route's `error` field) and `.status` on failure,
   * so callers can branch the same way on every platform:
   *
   *   try {
   *     const { issues } = await client.analyze(text);
   *   } catch (e) {
   *     if (e.code === 'rate_limited') ...
   *   }
   */
  function createClient(config) {
    config = config || {};
    var baseUrl = config.baseUrl || '';
    var fetchImpl = config.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('No fetch implementation available — pass { fetch } explicitly.');

    async function post(path, body, signal) {
      var res = await fetchImpl(baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON error body, fall through */ }
      if (!res.ok) {
        var err = new Error((data && data.message) || ('Request failed with status ' + res.status));
        err.code = (data && data.error) || 'unknown_error';
        err.status = res.status;
        throw err;
      }
      return data;
    }

    return {
      /** @returns {Promise<{issues: object[], truncatedAt: number|null}>} */
      analyze: function (text, signal) { return post('/api/analyze', { text: text }, signal); },

      /** @returns {Promise<{primary: string, traits: {name:string,score:number}[], note: string}>} */
      tone: function (text, signal) { return post('/api/tone', { text: text }, signal); },

      /** @param {string} style - one of: improve, shorten, expand, simplify, formal, casual, persuasive
       *  @returns {Promise<{text: string}>} */
      rewrite: function (text, style, signal) { return post('/api/rewrite', { text: text, style: style }, signal); },

      /** @returns {Promise<{text: string}>} */
      summarize: function (text, signal) { return post('/api/summarize', { text: text }, signal); }
    };
  }

  return { createClient: createClient };
});
