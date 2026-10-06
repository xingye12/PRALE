# MemoryPanel request flow: HTTP route → kernel adapter → envelope

Scope: the Control/data-plane path that proxies panel HTTP calls into the memory
kernel `/v3/meta/*` and `/v3/skill/*` HTTP APIs. Evidence task `learn/15`, repo `tdam`.

## Mermaid

```mermaid
flowchart TD
  C[Browser / panel UI] -->|POST /api/v1/meta/:action<br/>x-tdai-service-id, x-tdai-user-key| APP

  subgraph Hono app["buildPanelApp (http/app.ts:17)"]
    APP[requestLogger middleware<br/>http/middleware/request-logger.ts:36] --> ROUTE["api.post('/meta/*')<br/>routes/meta/proxy.ts:149"]
    ROUTE --> MW["validatePanelMetaHeaders<br/>http/middleware/validate-panel-headers.ts:31"]
  end

  MW -->|reads META_HEADER_SERVICE_ID / _USER_KEY<br/>kernel/headers.ts:5-7| REG[(InstanceRegistry.resolve)]
  REG -->|entry: instance_id, gateway_endpoint, api_key| CTX[c.set('panelMeta', ...)<br/>validate-panel-headers.ts:55-60]

  CTX --> HANDLER["meta proxy handler<br/>proxy.ts:150-218"]
  HANDLER --> DUP[checkDuplicate → metaKernel.invoke]
  HANDLER --> PORT["deps.metaKernel.invoke(action, body, ctx)<br/>ports/meta-kernel-port.ts"]
  PORT --> ADAPTER["FetchMetaKernelAdapter.invoke<br/>adapters/fetch-meta-kernel-adapter.ts:12"]
  ADAPTER -->|toKernelCredentials ctx→KernelCredentials<br/>kernel/types.ts:23| HTTP["FetchKernelHttpAdapter.postEnvelope<br/>adapters/fetch-kernel-http-adapter.ts:13"]
  HTTP --> FETCH["executeMetaFetch<br/>kernel/transport-fetch.ts:125"]
  FETCH -->|POST base+/v3/meta/action<br/>Content-Type, Authorization Bearer,<br/>x-tdai-service-id, x-request-id, x-tdai-user-key| KERNEL[(MemoryKernel v3 HTTP)]

  KERNEL -->|JSON {code,message,request_id,data}| FETCH
  FETCH --> ENV["MetaEnvelope<br/>kernel/envelope.ts:3-8"]
  ENV --> MAP["mapHttpStatusFromEnvelopeCode<br/>kernel/envelope.ts:11<br/>0→200, 400-599→code, else 502"]
  MAP --> RESP["respondEnvelope<br/>http/envelope.ts:18"]
  RESP --> C
```

## ASCII fallback

```
panel UI
  |  POST /api/v1/meta/{action}   headers: x-tdai-service-id, x-tdai-user-key, x-request-id
  v
requestLogger            (http/middleware/request-logger.ts:36)  -> ctx.reqId, response x-request-id
  v
POST /meta/* route       (http/routes/meta/proxy.ts:149)
  v
validatePanelMetaHeaders (http/middleware/validate-panel-headers.ts:31)
  |-- read header names from kernel/headers.ts:5-7
  |-- instanceRegistry.resolve(instanceId) -> 400 INVALID_INSTANCE on miss
  |-- userKey required unless action == "auth/verify"
  '-- c.set('panelMeta', {instanceId, gatewayEndpoint, gatewayApiKey, userKey})
  v
meta proxy handler       (http/routes/meta/proxy.ts:150-218)
  |-- action allowlist (404 / 501) and optional duplicate pre-check
  v
MetaKernelPort.invoke    (ports/meta-kernel-port.ts)  implemented by
FetchMetaKernelAdapter   (kernel/adapters/fetch-meta-kernel-adapter.ts:12)
  |-- sanitizeBody for non-list actions
  |-- toKernelCredentials (kernel/types.ts:23) -> KernelCredentials (omitUserKey for auth/verify)
  v
KernelHttpPort.postEnvelope (kernel/adapters/fetch-kernel-http-adapter.ts:13)
  v
executeMetaFetch         (kernel/transport-fetch.ts:125)
  |-- POST {endpoint}/v3/meta/{action}
  |-- headers: Content-Type, Authorization: Bearer apiKey,
  |            x-tdai-service-id, x-request-id, x-tdai-user-key
  |-- timeout via AbortController; network/parse -> KernelFetchError(502), timeout -> 504
  v
MemoryKernel v3  ---- JSON { code, message, request_id, data } ---->  MetaEnvelope (kernel/envelope.ts:3)
  v
mapHttpStatusFromEnvelopeCode (kernel/envelope.ts:11)  then respondEnvelope (http/envelope.ts:18)
  v
panel UI
```

## Key observations

- **One header vocabulary, two directions.** `kernel/headers.ts` is the single
  definition of the three wire header names; the inbound middleware imports two
  of them and `transport-fetch.ts` imports all three, so inbound validation and
  outbound forwarding cannot drift.
- **Middleware is the trust boundary.** `validatePanelMetaHeaders` turns an
  untrusted `x-tdai-service-id` into a registry-resolved `gatewayEndpoint` /
  `gatewayApiKey`; the client never supplies the gateway credentials directly.
- **Envelope is the data-plane contract.** Both success and kernel error are
  carried as a `MetaEnvelope`; HTTP status is derived from `code` by
  `mapHttpStatusFromEnvelopeCode`, so the panel's HTTP surface mirrors the kernel
  error codes rather than collapsing them to a generic 500.
- **Adapter adds policy, transport adds mechanics.** `FetchMetaKernelAdapter`
  trims `limit`/`offset` for non-list actions and drops `user_key` for
  `auth/verify`; `FetchKernelHttpAdapter` converts thrown `KernelFetchError`
  into a normalised envelope (504 → `KERNEL_TIMEOUT`, 502 → `KERNEL_UNAVAILABLE`).
