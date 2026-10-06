# Contract deliverable — v3 SDK HTTP/error path: malformed error envelope

Repository: `tdam` · Task `12` · Mode: `contract`

Scope: `sdk/memory-core/typescript/src/v3` (HTTP/error path) and the shared
error type in `sdk/memory-core/typescript/src/errors.ts`.

## 1. Contract

`V3HttpTransport.request` (`src/v3/http.ts`) is the single decode path for every
v3 SDK call. Given an HTTP response it must always terminate in exactly one of
two outcomes:

- **Success:** `response.ok` **and** `envelope.code === 0` → resolve to
  `envelope.data` (with `x-trace-id` merged in as `trace_id`).
- **Failure:** any other response → throw a `TDAMError` (`src/errors.ts`) with a
  numeric `code`, a `requestId`, an optional `details` object, and
  `message` formatted as `[code] message (request_id=requestId)`.

A **malformed error envelope** is any response body that cannot supply that
contract — `null`, an array, a bare scalar, non-JSON bytes, or an object whose
`code`/`message` are missing or of the wrong type. The contract is that these
*never* escape as a raw `TypeError`, a parse crash, or a resolved success value:
they are **normalized to a `TDAMError`**.

## 2. Normalization table (the contract, executable)

| Case | Body (raw) | HTTP | Normalized result |
|---|---|---|---|
| `json_null_body` | `null` | 200 | `TDAMError(-1, "API response must be a JSON object", <header id>)` |
| `json_array_body` | `[]` | 200 | `TDAMError(-1, "API response must be a JSON object", <header id>)` |
| `non_json_error_body` | `<html>502 Bad Gateway</html>` | 502 | `TDAMError(502, <raw body>, <header id>)` |
| `string_code_error` | `{"code":"E_UPSTREAM","message":"upstream boom","request_id":"srv-42"}` | 502 | `TDAMError(502, "upstream boom", "srv-42")` |
| `missing_code_and_message` | `{"request_id":"srv-99"}` | 500 | `TDAMError(500, "HTTP 500", "srv-99")` |

Derivation rules, all in `V3HttpTransport.request`:

- `headerRequestId = x-qcloud-transaction-id ?? x-trace-id ?? ""` (lines 81–84).
- Non-JSON body → `code = response.ok ? -1 : status` (lines 87–95).
- JSON body that is not a non-null, non-array object → `code = -1`,
  message `"API response must be a JSON object"` (lines 97–103 — the guard added
  by this task, mirroring the Python v3 transport's `isinstance(envelope, dict)`).
- Object envelope with `!response.ok || businessCode !== 0` → numeric `code`
  is the business code when present and non-zero, otherwise the HTTP status;
  `requestId = headerRequestId || envelope.request_id || ""` (lines 105–118).

## 3. Artifacts

| Artifact | Role |
|---|---|
| `tests/fixtures/v3/malformed-error-envelope.json` | **The requested fixture.** Five malformed error envelopes, each with the response shape (`status`, `headers`, raw `body`) and the expected normalized `TDAMError`. |
| `tests/v3/run-malformed-envelope.mjs` | Executable demo. Drives the **real** `V3HttpTransport` against every fixture case plus a well-formed success control. |
| `tests/v3/undici-stub-hooks.mjs` | Node module-resolution hook used by the runner so it needs no `npm install` (stubs `undici`, maps `*.js` → `*.ts`). Validation scaffolding only. |
| `tests/v3/malformed-error-envelope.test.ts` | Vitest contract suite for the repo's configured `vitest run` (`tests/**/*.test.ts`). |
| `src/v3/http.ts` | Minimal source change: lines 97–103 guard the non-object JSON body. |

## 4. Executable demo / normalized operation result

```console
$ cd sdk/memory-core/typescript
$ node tests/v3/run-malformed-envelope.mjs
ok    json_null_body
ok    json_array_body
ok    non_json_error_body
ok    string_code_error
ok    missing_code_and_message
ok    control:well_formed_success  -- {"hit":1,"trace_id":"trace-ok"}

5 malformed-envelope case(s) + 1 control; 0 failure(s).
```

Exit code `0`. Each `ok` means the operation's normalized result was the expected
`TDAMError` (name, numeric `code`, `requestId`, and formatted `message`), and the
control confirms the guard did not alter successful unwrapping or `trace_id`
propagation.

**Regression witness.** Before the source guard, the same demo failed the first
case with:

```
THREW TypeError TypeError "Cannot read properties of null (reading 'code')" code= undefined
```

i.e. a malformed `null` envelope crashed the transport with a raw `TypeError`.

## 5. Validation & limitations

- Executed: `node tests/v3/run-malformed-envelope.mjs` → **passed** (Node
  v24.14.0, native TS type-stripping; real `src/v3/http.ts` + `src/errors.ts`).
- **Not executed:** `vitest run` / `tsc`. No `node_modules` are present and
  dependency installation is out of scope for this task, so the vitest suite is
  delivered but unrun here. The `mjs` runner covers the identical assertions.
- No task metadata, hidden-oracle files, package locks, or git configuration were
  modified. Source change is confined to the 7-line guard in `src/v3/http.ts`.
