# T06 — Contract deliverable: typed/normalized metadata-client failure

- **Repository key:** `tdam`
- **Task mode:** `contract`
- **Subject:** v3 `MetadataClient` (`/v3/meta/*`, TypeScript SDK) failure surface
- **Chosen failure family:** remote/response failures of the **metadata** client
  (the sibling `MemoryPromptClient` is covered as a cross-check, so the contract
  is not metadata-only)
- **Executable demo:** `.prale-eval/metadata-client-failure.contract.mjs` (10/10 cases pass)
- **Result record:** `.prale-eval/result.json`
- **Citation check:** `.prale-eval/validate-evidence.mjs`

## 1. Contract (the assertion being made)

> A failure raised while calling `MetadataClient` MUST reach the caller as a
> **typed, normalized SDK error** and MUST NOT leak a raw response shape
> (a `Response`, a raw body string, or a bare `{ code, message }` envelope
> object).

Two typed shapes exist and they are disjoint by `instanceof`:

| Failure origin | Typed error | Normalized fields |
| --- | --- | --- |
| Remote response (non-2xx, non-zero envelope code, unparseable body) | `TDAMError` (`Error` subclass) | `code: number`, `requestId: string`, `details?: object`, `message === "[<code>] <message> (request_id=<id>)"`, `name === "TDAMError"` |
| Local validation / configuration (missing API key, non-object payload, under-specified list call) | `ParamError` (`TypeError` subclass) | `name === "ParamError"`, operation-scoped message; thrown **synchronously, before any HTTP request** |

Normalization is performed once, in `V3HttpTransport.request`, which all v3
clients share. The rules the demo pins down:

1. **Envelope business code wins when non-zero:** `!response.ok || businessCode !== 0`
   ⇒ `code = businessCode` (e.g. `41002`).
2. **HTTP status is the fallback:** when the envelope carries `code: 0` or a
   non-numeric code, `code = response.status` (e.g. `401`).
3. **Request-id folding:** `x-qcloud-transaction-id` → `x-trace-id` →
   `envelope.request_id` → `""`.
4. **Non-JSON bodies are wrapped, never returned raw:** on a 2xx the sentinel
   code is `-1`, otherwise the HTTP status; the raw text only appears *inside*
   the normalized `message`.
5. **Diagnostics are narrowed:** envelope `data` (object) becomes `TDAMError.details`,
   not the whole envelope.
6. **Success never leaks the envelope:** only `data` (plus `trace_id`) is returned.

## 2. Executable demo (`node .prale-eval/metadata-client-failure.contract.mjs`)

The demo loads the **unmodified** sources with Node's built-in type stripping and
stubs `globalThis.fetch`, so it needs no network, no build step and no npm
install:

- `sdk/memory-core/typescript/src/v3/metadata-client.ts` — `MetadataClient`
- `sdk/memory-core/typescript/src/v3/http.ts` — `V3HttpTransport`
- `sdk/memory-core/typescript/src/errors.ts` — `TDAMError`, `ParamError`
- `sdk/memory-core/typescript/src/v3/memory-prompt-client.ts` — `MemoryPromptClient`

Assertion helper `assertTypedFailure()` checks, for every failure case, that the
rejection is an `Error` whose **prototype is the SDK class itself** (not a
duck-typed literal), is `name`d correctly, is **not** a `Response` and **not** a
string, and — for `TDAMError` — carries a numeric `code`, string `requestId`,
a message of the form `[<code>] <message> (request_id=<id>)` built by the SDK, and
`details` that is never the raw envelope.

| # | Scenario (stubbed gateway answer) | Asserted normalized result |
| --- | --- | --- |
| 1 | HTTP 500, envelope `{code: 41002}` + `x-qcloud-transaction-id` | `TDAMError` 41002, `requestId = txn-abc` (header beats envelope), no `data` spread on the error |
| 2 | HTTP 500, envelope `{code: 50003, request_id}` and no trace headers | `requestId = srv-req-42` (envelope fallback) |
| 3 | HTTP 502 with `text/html` body | `TDAMError` **502** (HTTP status), body only inside the message |
| 4 | HTTP 200 with non-JSON body | `TDAMError` **-1** (sentinel), body only inside the message |
| 5 | HTTP 409, envelope `{code: 40901, data:{current_version: 7}}` | `details` deep-equals `{current_version: 7}`; not the envelope |
| 6 | HTTP 401, envelope `{code: 0, message:"unauthorized"}` | `TDAMError` **401** (status fallback), `details === undefined` |
| 7 | HTTP 200, `{code: 0, data:{user_id}}` + `x-trace-id` (control) | resolves `{user_id, trace_id}`; `code`/`data` keys do not leak |
| 8 | local validation: `createUser(undefined)`, `listTeams({})`, `listTasks({})`, missing `apiKey` | `ParamError` (also `instanceof TypeError`), operation-scoped messages, **0** fetch calls |
| 9 | prompt-client HTTP 500, envelope `{code: 42007}` | same normalized `TDAMError`; GET URL is `/v3/memory-prompt/get?memory_prompt_id=p1` |
| 10 | injected `Transport` rejecting with a `TDAMError` (constructor overload) | the *same* object is rethrown (identity preserved, not re-wrapped) |

Observed output (tail):

```
✔ metadata failure: business code inside HTTP error envelope is normalized to TDAMError
✔ metadata failure: request_id falls back to the envelope field
✔ metadata failure: non-JSON body is wrapped in a typed TDAMError, not returned raw
✔ metadata failure: HTTP 200 non-JSON body becomes TDAMError with sentinel code -1
✔ metadata failure: conflict diagnostics are preserved as `details`, not the whole envelope
✔ metadata failure: HTTP status is used when the envelope carries code 0
✔ metadata control: success unwraps `data` and never exposes the envelope
✔ metadata failure: local payload validation throws ParamError without any HTTP call
✔ prompt client failure: the sibling client exposes the same typed TDAMError
✔ metadata failure: an injected transport's TDAMError propagates unchanged
ℹ tests 10  ℹ pass 10  ℹ fail 0
```

## 3. Source evidence (see `result.json` → `evidence`)

Required path: **`sdk/memory-core/typescript/src/v3/metadata-client.ts`**.

| Path | Symbol | Lines | Task-relevant behavior |
| --- | --- | --- | --- |
| `.../v3/metadata-client.ts` | `MetadataClient` | 112–133 | class + config/Transport constructor overloads; `ParamError` for bad config |
| `.../v3/metadata-client.ts` | `body` | 80–85 | strips `undefined`; non-object payload ⇒ `ParamError` |
| `.../v3/metadata-client.ts` | `requireAnyString` | 87–95 | operation-scoped `ParamError` for under-specified calls |
| `.../v3/metadata-client.ts` | `listTeams` | 176–189 | validated list call (`user_id`/`user_key`) |
| `.../v3/metadata-client.ts` | `listTasks` | 212–226 | validated list call (`team_id`/`creator_*`) |
| `.../v3/metadata-client.ts` | `getUser` | 137–140 | read path used by cases 1/2/7 |
| `.../v3/metadata-client.ts` | `verifyAuth` | 274 | case 6 (HTTP status fallback) |
| `.../v3/metadata-client.ts` | `getInstanceQuota` | 277 | case 4 (non-JSON on 2xx) |
| `.../v3/http.ts` | `V3HttpTransport` | 8–56 | shared transport; config validation |
| `.../v3/http.ts` | `request` | 58–121 | the whole normalization algorithm |
| `.../errors.ts` | `TDAMError` | 12–33 | typed remote failure (`code`, `requestId`, `details`) |
| `.../errors.ts` | `ParamError` | 5–10 | typed local failure (`TypeError` subclass) |
| `.../v3/memory-prompt-client.ts` | `MemoryPromptClient` | 46–70 | sibling client, same normalizer (case 9) |

## 4. How to reproduce

```bash
cd <workspace>
node .prale-eval/metadata-client-failure.contract.mjs   # 10/10 contract cases
node .prale-eval/validate-evidence.mjs                  # citations/lines verified
```

Offline harness notes:

- `.prale-eval/harness/loader.mjs` registers an ESM resolve hook that maps the
  SDK's `./x.js` specifiers onto `./x.ts` (Node type stripping does not rewrite
  them) and substitutes `undici` (declared dependency of `src/v3/http.ts`, not
  installed here).
- `.prale-eval/harness/undici-shim.mjs` is a side-effect-free `Agent` stub; the
  TLS-relaxing dispatcher it serves is never constructed by the demo.

## 5. Limitations recorded

- **`vitest` (the repository's own runner, `npm test` → `vitest run`) is not
  installed** and installing dependencies was out of scope for this offline run,
  so the vendored vitest suite could not be executed; the equivalent contract is
  executed with Node's built-in test runner instead.
- **No repository source file was modified**: only `.prale-eval/` artifacts were
  added. `git status --porcelain` reports exactly `?? .prale-eval/`. Task
  metadata, hidden-oracle files, package locks and git configuration are
  untouched.
