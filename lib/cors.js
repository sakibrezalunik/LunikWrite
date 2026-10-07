/**
 * Native iOS/Android requests aren't subject to browser CORS at all, but a
 * Capacitor/WebView-wrapped build, or any future web client on a different
 * origin than this API, will be. Set ALLOWED_ORIGIN in the environment to a
 * specific origin in production; "*" is fine for local development only.
 */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

export function jsonWithCors(body, init) {
  init = init || {};
  const headers = Object.assign({}, corsHeaders(), init.headers || {});
  return Response.json(body, Object.assign({}, init, { headers }));
}

/** Reuse in each route.js: export const OPTIONS = () => corsPreflight(); */
export function corsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
