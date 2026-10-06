// Test double for server/core/gateway-client.js (used only by the contract demo).
// The real module is bypassed via a node:module resolve hook so that no network,
// database or env access is required. The behaviour is driven by a handler that
// the demo installs on globalThis before importing config-queue.js.
export async function gatewayAdminRpc(method, params = {}, timeoutMs = 15_000) {
  const handler = globalThis.__configQueueRpcHandler
  if (typeof handler !== 'function') throw new Error('stub-gateway-client: no RPC handler installed')
  return handler(method, params, timeoutMs)
}
