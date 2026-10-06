/**
 * Node loader hook: resolve the repo's bundler-style `./x.js` specifiers to the
 * actual TypeScript source `./x.ts`, so the fixture can import the real modules
 * (build-queue.ts / serial-queue.ts / code-graph-service.ts) with zero external
 * dependencies and zero copies of production logic.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    try {
      return await nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    } catch {
      /* fall through to default resolution */
    }
  }
  return nextResolve(specifier, context);
}
