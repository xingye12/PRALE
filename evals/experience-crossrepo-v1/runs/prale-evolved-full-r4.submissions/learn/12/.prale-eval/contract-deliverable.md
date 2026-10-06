# Contract deliverable — v3 SDK malformed error envelope (task 12, `tdam`)

## What was contracted

The v3 SDK HTTP/error path in `sdk/memory-core/typescript/src/v3/http.ts`
(`V3HttpTransport.request`), together with its error surface in
`sdk/memory-core/typescript/src/errors.ts` (`TDAMError`, `ParamError`).

A real gateway can return an HTTP error whose JSON body is *almost* a v3
`ApiResponseEnvelope` but is off-spec. The contract is that the transport never
crashes on such a body and instead normalizes it into a `TDAMError` with
deterministic fields:

| envelope defect | transport behavior |
| --- | --- |
| `code` is not a number | business code discarded; `TDAMError.code` falls back to the HTTP status |
| `message` empty/null | `TDAMError.message` falls back to `HTTP <status>` |
| body has no usable `request_id` | request id comes from the `x-qcloud-transaction-id` / `x-trace-id` response header (body `request_id` only as fallback) |
| `data` is not an object | `TDAMError.details` is `undefined` |

Grounding: `http.ts:97` (`businessCode` type-guard), `http.ts:98-109` (throw
branch with the status/message/details fallbacks), `http.ts:81-84` (header
request id), `errors.ts:12-33` (`TDAMError`), `errors.ts:5-10` (`ParamError`).

## Deliverables

1. **Fixture — `sdk/memory-core/typescript/tests/fixtures/malformed-error-envelope.json`**
   The malformed envelope under contract:
   - HTTP `503 Service Unavailable`, header `x-qcloud-transaction-id: txn-malformed-0001`
   - body `{"code":"E_BACKEND_UNAVAILABLE","message":null,"data":"upstream overloaded"}`
     (string `code`, null `message`, primitive `data`)
   - `expected_error`: `TDAMError` `code 503`,
     message `[503] HTTP 503 (request_id=txn-malformed-0001)`, no details.

2. **CI contract test — `sdk/memory-core/typescript/tests/v3-http-malformed-envelope.test.ts`**
   A vitest suite that loads the fixture, stubs global `fetch` with the fixture
   response, and asserts the normalized `TDAMError`.

3. **Executable demo — `sdk/memory-core/typescript/tests/run-malformed-envelope-demo.mjs`**
   Dependency-free runner that loads the *real* `src/v3/http.ts` (Node 24 type
   stripping, resolving the bare `undici` import to a stub `Agent` and mapping
   NodeNext `.js` specifiers to `.ts`), feeds the fixture through a stubbed
   `fetch`, and asserts the contract.

4. **Validator — `.prale-eval/validate.mjs`**
   Re-checks `result.json` metadata, that every cited symbol occurs inside its
   cited line range, that both contract paths have evidence and claims, and that
   the fixture is genuinely malformed.

## Normalized operation result

Running the demo against the fixture:

```
$ node sdk/memory-core/typescript/tests/run-malformed-envelope-demo.mjs
PASS malformed-error-envelope
  fixture : .../tests/fixtures/malformed-error-envelope.json
  request : POST http://127.0.0.1:9/v3/conversation/add
  thrown  : TDAMError code=503 message="[503] HTTP 503 (request_id=txn-malformed-0001)"
```

Running the validator:

```
$ node .prale-eval/validate.mjs
PASSED: 6 evidence entries, 4 claims
```

## Reproduce

```bash
cd sdk/memory-core/typescript
node tests/run-malformed-envelope-demo.mjs          # executable demo (no deps)
# with devDependencies installed:
npx vitest run tests/v3-http-malformed-envelope.test.ts
```

## Limitation

`undici` (runtime dependency) and `vitest` (devDependency) are **not installed**
in this checkout, and installing dependencies is out of scope. `npx vitest run`
therefore could not be executed; the vitest file is the CI-shaped equivalent and
the dependency-free demo + validator were run in its place. No package
manifests, locks, task metadata, or git configuration were modified.
