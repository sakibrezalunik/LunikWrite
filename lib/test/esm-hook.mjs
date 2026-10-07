/**
 * Node module-loading hooks for lib/api-routes.test.js.
 *
 * The route handlers and lib/ai/* files are ES modules, but they live in
 * `.js` files without a package.json "type": "module" (the grammar engine is
 * deliberately UMD so it can also run in browsers and React Native). These
 * hooks let the plain-Node test runner load the ESM files as ESM, without
 * changing how Next.js builds them in the real app.
 *
 * Registered from the test via node:module's register().
 */

const PROJECT_FILE = /^file:\/\/\/.*\/lunik-web\//;

export async function resolve(specifier, context, nextResolve) {
  // Relative .js specifiers stay relative; the load hook decides the format.
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (PROJECT_FILE.test(url) && url.endsWith('.js') && !url.includes('/node_modules/')) {
    const { readFile } = await import('node:fs/promises');
    let source = await readFile(new URL(url), 'utf8');
    if (url.endsWith('/lib/grammar-engine.js')) {
      // grammar-engine.js is a UMD bundle: under ESM its `root` fallback
      // (`this`) is undefined, so point it at globalThis instead, then
      // re-export the factory result as the module default. The file itself
      // on disk is NOT modified — this patch only exists for tests.
      source = source.replace(': this,', ': globalThis,');
      source += "\nexport default globalThis.LunikGrammarEngine;";
    }
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
