// Node module-resolution hook: redirect the uninstalled `check-disk-space`
// bare specifier to a local stub so the real server/core/system.js can be
// imported without installing dependencies.
const STUB = new URL('./check-disk-space-stub.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'check-disk-space') {
    return { url: STUB, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
