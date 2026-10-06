// Minimal resolver hook: redirects only the module boundaries listed in the
// fixture contract to the shared in-memory doubles in ./mocks.mjs.
// Everything else resolves normally, so the fixture executes the real
// session-sync / usage-sync / session-usage-cache source files.

const MOCK_URL = new URL('./mocks.mjs', import.meta.url).href

const REDIRECTS = [
  { parentSuffix: '/server/core/session-usage-cache.js', specifier: '../database.js' },
  { parentSuffix: '/server/core/usage-sync.js', specifier: './gateway-client.js' },
  { parentSuffix: '/server/core/usage-sync.js', specifier: './multi-tenant-gateway.js' },
  { parentSuffix: '/server/core/usage-sync.js', specifier: './sse.js' },
  { parentSuffix: '/server/core/session-sync.js', specifier: '../user-manager.js' },
]

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || ''
  const hit = REDIRECTS.some(
    (r) => parent.endsWith(r.parentSuffix) && specifier === r.specifier,
  )
  if (hit) return { url: MOCK_URL, shortCircuit: true }
  return nextResolve(specifier, context)
}
