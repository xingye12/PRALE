# T17 — Contract deliverable: metadata client failures are typed/normalized

**Task:** Contract a different metadata or prompt client failure: assert it exposes a
typed/normalized failure instead of leaking a raw response shape.
**Repository:** `tdam` · **Mode:** `contract` · **Scope:** `MetadataClient` (v3 management plane).

## What is contracted

`MetadataClient` (`sdk/memory-core/typescript/src/v3/metadata-client.ts`) must never
surface a raw response shape to the caller. Its two failure classes and its success
path are pinned to these guarantees:

| # | Situation | Contracted outcome |
|---|-----------|--------------------|
| 1 | Server returns an HTTP 200 envelope with a non-zero business `code` | rejects with `TDAMError`; numeric `.code`, string `.requestId`, structured `.details`; the raw `{code,message,request_id,data}` envelope is **not** the thrown value |
| 2 | Server returns a non-OK HTTP status | rejects with `TDAMError` whose `.code` is the numeric HTTP status |
| 3 | Server returns a non-JSON body | rejects with `TDAMError` (`.code` = HTTP status, or `-1` for an `ok` status) |
| 4 | Caller passes an invalid argument (missing `apiKey`/`serviceId`, non-object payload, missing list selector) | throws `ParamError` (a `TypeError` subclass) **before** dispatch |
| 5 | Server returns a valid success envelope | resolves to the normalized operation result = `envelope.data` (+ `trace_id`); envelope keys `code`/`message`/`request_id` are **not** copied onto the result |

Why this holds: `MetadataClient(config)` constructs a `V3HttpTransport`
(`metadata-client.ts:124-131`), so every `/v3/meta/*` and `/v3/knowledge/*` call is
routed through `V3HttpTransport.request` (`v3/http.ts:58-113`), which is the single
normalization point (`TDAMError` at lines 90 and 104; `envelope.data`-only return at
line 112). Client-side guards (`body` at `metadata-client.ts:80-85`,
`requireAnyString` at `:87-95`) use `ParamError` (`errors.ts:5`).

## Executable demo

```
node --import ./.prale-eval/demo/register.mjs ./.prale-eval/demo/metadata-failure-contract.mjs
```

`.prale-eval/demo/metadata-failure-contract.mjs` loads the **real, unmodified**
`sdk/memory-core/typescript/src/v3/metadata-client.ts`, replaces `globalThis.fetch`
with an in-process stub that replays canned `Response` objects, and asserts the
contract clauses above. No network I/O, no build step, no installed dependencies.

Supporting files:

- `.prale-eval/demo/register.mjs` — registers the resolve hook.
- `.prale-eval/demo/loader.mjs` — maps TS-bundler-style `./x.js` specifiers to the
  sibling `./x.ts` (so Node's native type stripping can load the sources) and maps
  the uninstalled bare import `undici` to a local shim.
- `.prale-eval/demo/undici-shim.mjs` — minimal `Agent` stand-in used only for the
  unexercised `rejectUnauthorized === false` path.

### Observed normalized operation result (demo output)

10/10 contract cases pass (`summary = {total: 10, passed: 10, failed: 0}`, exit 0):

- `business_error_envelope_is_normalized_not_leaked` → `TDAMError{code:40901, requestId:"txn-hdr-1", details:{current_version:7}}`; `request_id`/`data` absent from the error object.
- `request_id_falls_back_to_envelope_when_no_trace_header` → `TDAMError{code:40301, requestId:"req-body-2"}`, `details === undefined`.
- `http_error_status_is_normalized_to_numeric_code` → `TDAMError{code:500}`.
- `non_json_success_body_is_normalized` → `TDAMError{code:-1}`.
- `non_json_http_error_body_is_normalized` → `TDAMError{code:502}`.
- `missing_api_key_is_typed_param_error` → `ParamError("apiKey must be provided")`.
- `invalid_endpoint_is_typed_param_error` → `ParamError("endpoint must be a valid HTTP(S) URL")`.
- `non_object_request_payload_is_typed_param_error` → `ParamError("request payload must be an object")`.
- `list_tasks_without_any_selector_is_typed_param_error` → `ParamError("listTasks requires one of team_id, creator_user_id, creator_user_key")`.
- `success_resolves_to_normalized_operation_result` → `{user_id:"u1", status:"active", trace_id:"trace-9"}` with no `code`/`message`/`request_id` keys.

## Evidence

| Path | Symbol | Lines | Task-relevant behavior |
|------|--------|-------|------------------------|
| `sdk/memory-core/typescript/src/v3/metadata-client.ts` | `MetadataClient` | 112–133 | Constructs a `V3HttpTransport` from config (the normalization path) or accepts an injected `Transport`; missing credentials fail as typed `ParamError`. |
| `sdk/memory-core/typescript/src/v3/metadata-client.ts` | `body` | 80–85 | Typed `ParamError` for non-object payloads, shared by `createUser`/`getUser`/etc. |
| `sdk/memory-core/typescript/src/v3/metadata-client.ts` | `requireAnyString` | 87–95 | Typed `ParamError` selector guard used by `listTeams`/`listTasks`. |
| `sdk/memory-core/typescript/src/v3/metadata-client.ts` | `getUserKey` | 167 | Representative one-line management call exercised by the primary failure case. |
| `sdk/memory-core/typescript/src/v3/metadata-client.ts` | `listTasks` | 212–226 | Client-side selector validation (line 224) exercised by the ParamError case. |
| `sdk/memory-core/typescript/src/v3/http.ts` | `request` | 58–113 | Single normalization point: `TDAMError` for non-JSON / non-zero code / non-OK status; returns only `envelope.data` + `trace_id`. |
| `sdk/memory-core/typescript/src/errors.ts` | `TDAMError` | 12–30 | Typed failure shape: numeric `code`, string `requestId`, optional `details`; sibling `ParamError` is a `TypeError`. |

## Validation

```
node --import ./.prale-eval/demo/register.mjs ./.prale-eval/demo/metadata-failure-contract.mjs && node .prale-eval/verify-citations.mjs
```

- **Demo:** 10/10 contract cases pass, exit 0.
- **Citation check** (`.prale-eval/verify-citations.mjs`): `result.json` metadata matches the
  current `TASK.md`; every evidence symbol occurs inside its cited inclusive range; the
  required path is cited and claim-covered; every claim path exists and is cited.

## Limitations (recorded, not hidden)

- No `node_modules/` is present and dependencies must not be installed, so the package's
  own `tsc` build and `vitest` suite could not run. The demo is the focused substitute
  validation; it exercises the real source via Node 24 native type stripping.
- **Boundary (not contracted):** a malformed *success* envelope — `code: 0` with a
  non-object `data` — is passed through unchanged (`V3HttpTransport.request` asserts the
  envelope is parseable JSON but not that `data` is an object). The demo records this as
  `boundary_probes` only; it is outside the failure contract asserted here.
