/**
 * Node module-resolution hook: redirect the bare specifier `dotenv` to the local
 * zero-dependency stub so the REAL panel-config.ts can be imported and executed
 * without installing node_modules (no dependency is installed by this task).
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'dotenv') {
    return { url: new URL('./dotenv-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
