/**
 * hooks.mjs — Node module-resolution hook.
 * Redirects the bare specifier "yaml" (a dependency not installed in this
 * environment) to the labelled demo test double. Everything else resolves
 * normally, so the real repository modules run unmodified.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "yaml") {
    return { url: new URL("./yaml-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
