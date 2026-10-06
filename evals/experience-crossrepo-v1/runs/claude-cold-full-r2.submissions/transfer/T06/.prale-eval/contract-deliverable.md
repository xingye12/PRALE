# Contract — metadata / memory-prompt client failures are normalized, not raw

Repository: `tdam` · Task: `T06` · Mode: `contract`

## Contract statement

For the v3 metadata (`MetadataClient`) and memory-prompt (`MemoryPromptClient`)
clients, any failure of an operation must reach the caller as a **typed,
normalized failure**:

- `TDAMError` (`name`, numeric `code`, `requestId`, optional `details`) for a
  transport/API failure, or
- `ParamError` for caller-supplied input rejected before the request is sent.

A failure must **never leak a raw response shape** — not a bare JS `TypeError`
raised from parsing/probing the response, and not a raw primitive/array handed
back as if it were the requested entity.

## Why metadata/prompt clients are the right surface

`MetadataClient` owns no error handling of its own — every operation returns
`this.http.post(...)` directly (`sdk/memory-core/typescript/src/v3/metadata-client.ts:136-291`, class at `:112-133`).
`MemoryPromptClient` shares the same `V3HttpTransport` constructor
(`memory-prompt-client.ts:46-66`). The typed-failure contract therefore lives
entirely in `V3HttpTransport.request`
(`sdk/memory-core/typescript/src/v3/http.ts:58-135`), and any raw shape it lets
through is what a metadata or prompt caller actually sees.

## The failure that was leaking

`V3HttpTransport.request` already normalized the common cases:

| Response | Result |
| --- | --- |
| HTTP 200, `{ code: 40003, message, request_id }` | `TDAMError(40003, …, requestId=…)` |
| HTTP 200, error envelope with `data` | `TDAMError(…, details=data)` |
| HTTP 5xx, non-JSON body | `TDAMError(status, bodyText, headerRequestId)` |
| body has `code !== 0` | `TDAMError(code, message, header > envelope request id)` |

but it did not guard the **shape** of the envelope or of `data`, so two raw
shapes escaped:

1. **JSON `null` envelope** → `JSON.parse("null")` gives `null`, then
   `envelope.code` raises a raw
   `TypeError: Cannot read properties of null (reading 'code')`.
2. **Non-object success `data`** → `{ "code": 0, "data": "raw-string" }` (or a
   number/array) was resolved to the caller typed as the requested entity.

The Python sibling transport already contracts both in
`_decode_response` (`sdk/memory-core/python/tencentdb_agent_memory/_v3_http.py:38-71`):
`"API response must be a JSON object"` and
`"API response data must be a JSON object"`. This is the transferred
experience: the TypeScript transport now mirrors those two guards, so the
metadata and prompt clients reject with `TDAMError(-1, …)` instead of leaking.

## The change (minimal)

`sdk/memory-core/typescript/src/v3/http.ts` — 15 added lines, two guards:

```ts
// after JSON.parse, before reading envelope.code
if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
  throw new TDAMError(-1, "API response must be a JSON object", headerRequestId);
}

// after resolving data, before returning to the caller
const result = (envelope.data ?? {}) as T & { trace_id?: string };
if (result === null || typeof result !== "object" || Array.isArray(result)) {
  throw new TDAMError(-1, "API response data must be a JSON object", headerRequestId);
}
```

Legitimate responses are unaffected: a normal envelope is an object and its
`data` is an object (absent/`null` `data` still becomes `{}` as before).

## Executable demo

Two artifacts assert the exact same contract:

1. **In-repo vitest suite** (durable CI contract):
   `sdk/memory-core/typescript/tests/v3-metadata-failure-contract.test.ts`
   — matches the package's `vitest.config.ts` include (`tests/**/*.test.ts`).

2. **Self-contained runner** (executes with no installed dependencies):
   [`.prale-eval/contract/run-contract.mjs`](contract/run-contract.mjs)
   loads the real TypeScript sources under Node via
   [`.prale-eval/contract/register.mjs`](contract/register.mjs) +
   [`loader.mjs`](contract/loader.mjs) (maps TS `.js` specifiers to `.ts` and
   shims the uninstalled `undici` bare specifier), replays canned HTTP
   responses onto `globalThis.fetch`, and asserts the normalized outcome.

```
node --import ./.prale-eval/contract/register.mjs \
     ./.prale-eval/contract/run-contract.mjs
```

### Observed results

Fixed sources — **14/14 assertions pass, exit 0**:

```
metadata client — already-normalized failure shapes
  ok  business code !== 0 rejects with TDAMError(code, requestId)
  ok  envelope data on an error is preserved as typed details
  ok  non-JSON HTTP 500 rejects with TDAMError(500), not a raw Response
  ok  request id prefers the transport header over the envelope
metadata client — envelope-shape failures (the contracted leak)
  ok  JSON null envelope rejects with TDAMError, not a raw TypeError
  ok  JSON null envelope over HTTP 500 still normalizes
  ok  primitive JSON envelope rejects instead of leaking the value
  ok  non-object success data rejects instead of returning a raw primitive
  ok  numeric success data rejects instead of returning a raw number
  ok  array success data rejects instead of returning a raw array
  ok  well-formed success still resolves with the typed entity
memory-prompt client — same transport, same normalization
  ok  JSON null envelope rejects with TDAMError, not a raw TypeError
  ok  non-object success data rejects instead of returning a raw primitive
  ok  invalid parameters reject with the typed ParamError

14/14 contract assertions passed
```

Untouched baseline (`git stash` of the 15-line change) — **6/14, exit 1**,
including the leak itself:

```
FAIL  JSON null envelope rejects with TDAMError, not a raw TypeError
      expected a normalized TDAMError, got TypeError: Cannot read properties of null (reading 'code')
FAIL  non-object success data rejects instead of returning a raw primitive
      expected the operation to reject, but it resolved
```

Because the contract fails on the pre-fix tree and passes after the change, it
is a real regression barrier rather than a restatement of current behaviour.

## Normalized operation result (shape the contract pins)

```jsonc
// metadata.getUser("u1") against { code: 40901, message: "stale", data: { current_version: 7 } }
{ "name": "TDAMError", "code": 40901, "requestId": "", "details": { "current_version": 7 },
  "message": "[40901] stale (request_id=)" }

// metadata.getUser("u1") against body "null"
{ "name": "TDAMError", "code": -1, "requestId": "",
  "message": "[-1] API response must be a JSON object (request_id=)" }

// metadata.getUser("u1") against { code: 0, data: "raw-string" }
{ "name": "TDAMError", "code": -1, "requestId": "",
  "message": "[-1] API response data must be a JSON object (request_id=)" }

// prompt.getEffective({}) with no team_id
{ "name": "ParamError", "message": "team_id is required for effective prompt lookup" }
```

## Validation limitations

This workspace has no `node_modules` (and none may be installed here), so
`npm test` / vitest and `undici` are unavailable; the in-repo vitest suite was
therefore not executed (it parses cleanly under `node --check`). The runner
above works around this with a Node loader hook and a minimal `undici` stub
whose `Agent` is never constructed under the secure default used here, so the
normalization path under test is the real source. `tsc` is likewise
unavailable, so no type-level check was run.

## Files

| File | Role |
| --- | --- |
| `sdk/memory-core/typescript/src/v3/http.ts` | fix: two envelope-shape guards (15 lines) |
| `sdk/memory-core/typescript/tests/v3-metadata-failure-contract.test.ts` | durable vitest contract |
| `.prale-eval/contract/run-contract.mjs` | executable contract (dependency-free) |
| `.prale-eval/contract/loader.mjs`, `undici-stub.mjs`, `register.mjs` | loader harness for the above |
| `.prale-eval/result.json` | task result, evidence, claims, validation |
