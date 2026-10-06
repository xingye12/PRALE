// Node module-resolution hook: swap the single import of '../user-manager.js'
// inside the real server/core/session-sync.js for the in-memory stub, so the
// fixture executes the unmodified production module.

const STUB_URL = new URL('./user-manager.stub.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  const fromSessionSync = context.parentURL?.endsWith('/server/core/session-sync.js')
  if (fromSessionSync && specifier === '../user-manager.js') {
    return { url: STUB_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
