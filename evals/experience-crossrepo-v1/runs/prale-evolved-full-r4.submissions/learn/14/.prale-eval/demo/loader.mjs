/**
 * loader.mjs — ESM resolve hook that maps the bare specifier "yaml" onto the local
 * minimal shim, because the checkout has no installed dependencies.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "yaml") {
    return { url: new URL("./yaml-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
