# T06 — Contract: MetadataClient failures are typed, not raw response shapes

- **Task:** `T06` · **Repository:** `tdam` · **Mode:** `contract`
- **Required evidence file:** `sdk/memory-core/typescript/src/v3/metadata-client.ts`

## Contract statement

A failure raised by the v3 `MetadataClient` is **always a typed, normalized
failure** and never a leaked raw HTTP response shape:

| Failure kind | Normalized type | Carries |
| --- | --- | --- |
| Remote: business `code !== 0`, non-2xx, or non-JSON body | `TDAMError` (`errors.ts:12`) | numeric `code`, formatted `message`, `requestId`, optional normalized `details` |
| Local: malformed/selector-less request | `ParamError` (`errors.ts:5`) | the guard message; thrown **before** any HTTP call |

A caller must never observe a raw `Response`, a parsed-but-unvalidated
`{ code, message, data }` envelope, or a business object with `.data` attached.

## Where the contract is implemented

- `sdk/memory-core/typescript/src/v3/metadata-client.ts`
  - `requireAnyString` (`87–95`) and `body` (`80–85`) — local guards that raise
    `ParamError` for selector-less payloads (`listTeams` `176–189`,
    `listTasks` `214–226`).
  - `MetadataClient` constructor (`112–133`) — accepts an injected
    `Transport` (the `"post" in configOrTransport` overload), which is the seam
    used to drive the failure path deterministically.
  - `checkAcl` (`271`) — a representative metadata operation that delegates to
    the transport; the ACL perm-check is a *different* client failure from the
    skill-client contract exercised elsewhere.
- `sdk/memory-core/typescript/src/v3/http.ts` — `V3HttpTransport.request`
  (`58–121`) is the single normalization point: non-JSON → `TDAMError`
  (`86–95`); `!response.ok || code !== 0` → `TDAMError(code, message,
  requestId, details)` (`97–110`).
- `sdk/memory-core/typescript/src/errors.ts` — `TDAMError` (`12–33`),
  `ParamError` (`5–10`).

## Executable demo

`.prale-eval/validation/metadata-client.contract.ts` imports and runs the
**real** sources (only `globalThis.fetch` is stubbed) and asserts six cases:

1. `checkAcl` against HTTP 200 `{code:40001,message:"acl denied",request_id:"body-req-1"}`
   → rejects with `TDAMError` `code=40001`, message preserved, `requestId`
   from the envelope, **no `data` field leaked**, not a `Response`, has an
   `Error` stack.
2. HTTP 503 non-JSON `"upstream boom"` (`getInstanceQuota`) → `TDAMError`
   `code=503`, body text in `message`, `requestId` from `x-qcloud-transaction-id`.
3. HTTP 200 non-JSON `"<html>proxy error</html>"` (`getUser`) → `TDAMError`
   `code=-1`.
4. HTTP 200 `{code:40901,...,data:{current_version:7}}` (`getUserConfig`)
   → `TDAMError` with `details.current_version === 7` (normalized record).
5. `listTeams({})` → synchronous `ParamError` (a `TypeError`), **zero** fetch calls.
6. `listTasks({})` → `ParamError`, still **zero** fetch calls.

### Run it

```bash
node --import ./.prale-eval/validation/register.mjs \
     ./.prale-eval/validation/metadata-client.contract.ts
```

Observed result: **24 checks passed, 0 failed** (exit code 0), Node v24.14.0.

### Dependency note

`vitest` and `undici` are not installed in this workspace and installing
dependencies was out of scope. Node 24's native TypeScript type-stripping runs
the sources directly; `.prale-eval/validation/loader.mjs` (registered by
`register.mjs`) only (a) maps the bare specifier `undici` to a local no-op shim
and (b) rewrites the project's `./x.js` specifiers to `./x.ts`. No production
file, task metadata, lockfile, or git configuration was modified.
