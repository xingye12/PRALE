/**
 * Executable contract for T06 (repository `tdam`, mode `contract`).
 *
 * Property under contract:
 *   A failure raised by the v3 MetadataClient is ALWAYS a typed/normalized
 *   failure — `TDAMError` (remote) or `ParamError` (local) — and never the raw
 *   HTTP response shape (a `Response`, a parsed-but-unvalidated envelope, or a
 *   business `{ code, message, data }` object).
 *
 * Run (no npm install required):
 *   node --import ./.prale-eval/validation/register.mjs \
 *        ./.prale-eval/validation/metadata-client.contract.ts
 *
 * The demo drives the REAL sources under sdk/memory-core/typescript/src:
 *   - v3/metadata-client.ts  (MetadataClient)  -> required evidence file
 *   - v3/http.ts              (V3HttpTransport) -> the normalization point
 *   - errors.ts               (TDAMError / ParamError)
 * only `globalThis.fetch` is stubbed, so the failure path is genuinely
 * exercised end to end.
 */

import { MetadataClient } from "../../sdk/memory-core/typescript/src/v3/metadata-client.js";
import { V3HttpTransport } from "../../sdk/memory-core/typescript/src/v3/http.js";
import { TDAMError, ParamError } from "../../sdk/memory-core/typescript/src/errors.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** Replace global fetch with a single canned HTTP response. */
function stubFetch(init: {
  status: number;
  body: string;
  headers?: Record<string, string>;
}): void {
  globalThis.fetch = (async () => {
    return new Response(init.body, {
      status: init.status,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
}

function newClient(): MetadataClient {
  return new MetadataClient(
    new V3HttpTransport({
      endpoint: "https://memory.example.test",
      apiKey: "test-gateway-key",
      serviceId: "svc-test",
    }),
  );
}

/** Assert the rejection is a normalized TDAMError, not a leaked raw shape. */
function isNormalizedRemote(err: unknown): err is TDAMError {
  return (
    err instanceof TDAMError &&
    err instanceof Error &&
    err.name === "TDAMError" &&
    typeof err.code === "number" &&
    typeof err.message === "string"
  );
}

async function expectRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Capture a synchronous throw (local validation fails before returning a promise). */
function expectSyncThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw synchronously, but it returned");
}

async function main(): Promise<void> {
  console.log("T06 contract: MetadataClient failures are typed, not raw responses\n");

  // ── Case 1 — business-code failure (HTTP 200, code !== 0) ──────────────
  // checkAcl is an ACL/perm-check metadata operation: a distinct client
  // failure from the skill-client contract exercised elsewhere.
  stubFetch({
    status: 200,
    body: JSON.stringify({ code: 40001, message: "acl denied", request_id: "body-req-1" }),
  });
  {
    const err = await expectRejection(newClient().checkAcl({ asset_id: "a1", user_id: "u1" }));
    check("case1: checkAcl rejects with TDAMError", isNormalizedRemote(err), String(err));
    if (isNormalizedRemote(err)) {
      check("case1: code is the business code 40001", err.code === 40001, `code=${err.code}`);
      check("case1: message preserved", err.message.includes("acl denied"), err.message);
      check("case1: requestId normalized from envelope", err.requestId === "body-req-1", err.requestId);
      const raw = err as unknown as Record<string, unknown>;
      check("case1: raw envelope `data` field is NOT leaked", raw.data === undefined);
      check("case1: prototype is the typed error class", err instanceof TDAMError);
      check("case1: rejection is not a Response", !(err instanceof Response));
      check("case1: rejection carries an Error stack", typeof err.stack === "string");
    }
  }

  // ── Case 2 — HTTP error with a non-JSON body ───────────────────────────
  stubFetch({
    status: 503,
    body: "upstream boom",
    headers: { "x-qcloud-transaction-id": "txn-503" },
  });
  {
    const err = await expectRejection(newClient().getInstanceQuota());
    check("case2: non-JSON failure is TDAMError", isNormalizedRemote(err), String(err));
    if (isNormalizedRemote(err)) {
      check("case2: code is the HTTP status 503", err.code === 503, `code=${err.code}`);
      check("case2: body text carried in message", err.message.includes("upstream boom"), err.message);
      check("case2: requestId from gateway header", err.requestId === "txn-503", err.requestId);
    }
  }

  // ── Case 3 — 200 OK but non-JSON body ──────────────────────────────────
  stubFetch({ status: 200, body: "<html>proxy error</html>" });
  {
    const err = await expectRejection(newClient().getUser("u1"));
    check("case3: non-JSON 200 is TDAMError", isNormalizedRemote(err), String(err));
    if (isNormalizedRemote(err)) {
      check("case3: code is -1 for unusable body", err.code === -1, `code=${err.code}`);
      check(
        "case3: message describes the raw body",
        err.message.includes("proxy error") || err.message.includes("non-JSON"),
        err.message,
      );
    }
  }

  // ── Case 4 — diagnostic details are preserved, not leaked wholesale ────
  stubFetch({
    status: 200,
    body: JSON.stringify({ code: 40901, message: "version stale", data: { current_version: 7 } }),
  });
  {
    const err = await expectRejection(newClient().getUserConfig({ user_key: "u1" }));
    check("case4: conflict is TDAMError", isNormalizedRemote(err), String(err));
    if (isNormalizedRemote(err)) {
      check("case4: details normalized to a plain record", err.details?.current_version === 7, JSON.stringify(err.details));
      check("case4: message is the server message", err.message.includes("version stale"), err.message);
    }
  }

  // ── Case 5 — local validation failure, before any HTTP call ────────────
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  {
    const err = expectSyncThrow(() => newClient().listTeams({}));
    check("case5: missing selector rejects with ParamError", err instanceof ParamError, String(err));
    check("case5: ParamError is a TypeError", err instanceof TypeError, String(err));
    check("case5: ParamError name is typed", (err as Error).name === "ParamError");
    check("case5: no HTTP request leaked for bad input", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  }

  // ── Case 6 — same local contract on the task list operation ────────────
  {
    const err = expectSyncThrow(() => newClient().listTasks({}));
    check("case6: listTasks({}) rejects with ParamError", err instanceof ParamError, String(err));
    check("case6: still zero HTTP calls", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
