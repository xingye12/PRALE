/**
 * Contract demo — T06 / repository `tdam` / mode `contract`.
 *
 * Subject: the v3 **MetadataClient** (`/v3/meta/*`) failure surface.
 *
 * Contract under test
 * -------------------
 * Every metadata-client failure MUST surface to the caller as a typed,
 * normalized SDK error (`TDAMError` for transport/response failures,
 * `ParamError` for client-side validation failures) and MUST NOT leak a raw
 * response shape (a `Response`, a raw body string, or a bare
 * `{ code, message }` envelope object).
 *
 * The demo drives the real, unmodified sources:
 *   sdk/memory-core/typescript/src/v3/metadata-client.ts
 *   sdk/memory-core/typescript/src/v3/http.ts            (V3HttpTransport)
 *   sdk/memory-core/typescript/src/errors.ts             (TDAMError, ParamError)
 *
 * `globalThis.fetch` is stubbed, so no network access is required; the HTTP
 * error envelopes below are exactly what the gateway hands back.
 *
 * Run:  node .prale-eval/metadata-client-failure.contract.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Offline loader: maps the SDK's `./x.js` -> `./x.ts` specifiers and stubs the
// (not installed) `undici` dependency. See harness/loader.mjs.
register("./harness/loader.mjs", import.meta.url);

const { MetadataClient } = await import("../sdk/memory-core/typescript/src/v3/metadata-client.ts");
const { MemoryPromptClient } = await import("../sdk/memory-core/typescript/src/v3/memory-prompt-client.ts");
const { TDAMError, ParamError } = await import("../sdk/memory-core/typescript/src/errors.ts");

/** Real client config; the only network call is the stubbed global fetch. */
function makeClient() {
  return new MetadataClient({
    endpoint: "https://memory.example.test",
    apiKey: "kernel-token",
    serviceId: "svc-1",
  });
}

/** Success/control envelope as returned by the metadata gateway. */
function withStubbedFetch(responder, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

/**
 * Core normalization assertion: the rejection is a typed SDK error, and the raw
 * response shape never reaches the caller.
 */
function assertTypedFailure(error, { name, code }) {
  assert.ok(error instanceof Error, `${name} failure must be an Error instance`);
  assert.equal(error.name, name, `failure must be named ${name}`);
  assert.equal(
    Object.getPrototypeOf(error),
    name === "TDAMError" ? TDAMError.prototype : ParamError.prototype,
    `failure must be a real ${name} instance, not a duck-typed object`,
  );
  assert.ok(!(error instanceof Response), "failure must not be a raw Response object");
  assert.notEqual(typeof error, "string", "failure must not be a raw body string");
  if (name === "TDAMError") {
    assert.equal(typeof error.code, "number", "TDAMError.code must be a number");
    assert.equal(typeof error.requestId, "string", "TDAMError.requestId must be a string");
    assert.equal(typeof error.message, "string", "TDAMError.message must be a string");
    assert.ok(
      error.message.startsWith(`[${error.code}] `),
      `message must be normalized with the numeric code prefix, got: ${error.message}`,
    );
    assert.ok(
      error.details === undefined || (typeof error.details === "object" && error.details !== null),
      "TDAMError.details must be undefined or a plain diagnostics object",
    );
    if (error.details !== undefined) {
      assert.ok(!("code" in error.details), "details must not be the raw envelope");
    }
  }
  if (code !== undefined) {
    assert.equal(error.code, code, `failure code must be ${code}`);
  }
}

const json = (status, payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// ── 1. Business-code failure carried inside an HTTP error envelope ─────────
test("metadata failure: business code inside HTTP error envelope is normalized to TDAMError", () =>
  withStubbedFetch(
    () => json(500, { code: 41002, message: "user not found", request_id: "srv-req-9" },
      { "x-qcloud-transaction-id": "txn-abc", "x-trace-id": "trace-ignored" }),
    async () => {
      const error = await makeClient().getUser("u-missing").then(
        () => assert.fail("getUser must reject for a code!==0 envelope"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: 41002 });
      assert.equal(error.message, "[41002] user not found (request_id=txn-abc)");
      assert.equal(error.requestId, "txn-abc", "transport header wins over envelope request_id");
      assert.equal(error.details, undefined, "no diagnostics were supplied");
      assert.ok(!("data" in error), "raw envelope must not be spread onto the error");
    },
  ));

// ── 2. Envelope request_id fallback when no trace header is present ────────
test("metadata failure: request_id falls back to the envelope field", () =>
  withStubbedFetch(
    () => json(500, { code: 50003, message: "internal", request_id: "srv-req-42" }),
    async () => {
      const error = await makeClient().getUser("u1").then(
        () => assert.fail("getUser must reject"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: 50003 });
      assert.equal(error.requestId, "srv-req-42");
    },
  ));

// ── 3. Non-JSON body (e.g. gateway HTML error page) ───────────────────────
test("metadata failure: non-JSON body is wrapped in a typed TDAMError, not returned raw", () =>
  withStubbedFetch(
    () => new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html", "x-trace-id": "trace-502" },
    }),
    async () => {
      const error = await makeClient().listTeamMembers("team-1").then(
        () => assert.fail("listTeamMembers must reject"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: 502 });
      assert.equal(error.requestId, "trace-502");
      assert.match(error.message, /502 Bad Gateway/);
      assert.ok(error.message.startsWith("[502] "), "raw body is normalized behind a typed code");
    },
  ));

// ── 4. HTTP 200 with a non-JSON body ──────────────────────────────────────
test("metadata failure: HTTP 200 non-JSON body becomes TDAMError with sentinel code -1", () =>
  withStubbedFetch(
    () => new Response("not json at all", { status: 200, headers: { "x-trace-id": "trace-200" } }),
    async () => {
      const error = await makeClient().getInstanceQuota().then(
        () => assert.fail("getInstanceQuota must reject"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: -1 });
      assert.equal(error.requestId, "trace-200");
      assert.equal(error.message, "[-1] not json at all (request_id=trace-200)");
    },
  ));

// ── 5. Diagnostics in `data` are preserved as typed `details` ─────────────
test("metadata failure: conflict diagnostics are preserved as `details`, not the whole envelope", () =>
  withStubbedFetch(
    () => json(409, { code: 40901, message: "version stale", data: { current_version: 7 } }),
    async () => {
      const error = await makeClient().updateAgent({ agent_id: "a1" }).then(
        () => assert.fail("updateAgent must reject"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: 40901 });
      assert.deepEqual(error.details, { current_version: 7 });
      assert.equal(error.requestId, "");
    },
  ));

// ── 6. HTTP-status fallback when the gateway reports business code 0 ──────
test("metadata failure: HTTP status is used when the envelope carries code 0", () =>
  withStubbedFetch(
    () => json(401, { code: 0, message: "unauthorized", data: null }),
    async () => {
      const error = await makeClient().verifyAuth("bad-key").then(
        () => assert.fail("verifyAuth must reject"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: 401 });
      assert.equal(error.message, "[401] unauthorized (request_id=)");
      assert.equal(error.details, undefined);
    },
  ));

// ── 7. Control: the success path unwraps the envelope ─────────────────────
test("metadata control: success unwraps `data` and never exposes the envelope", () =>
  withStubbedFetch(
    () => json(200, { code: 0, data: { user_id: "u1", status: "active" }, request_id: "srv-1" },
      { "x-trace-id": "trace-ok" }),
    async () => {
      const result = await makeClient().getUser("u1");
      assert.equal(result.user_id, "u1");
      assert.equal(result.trace_id, "trace-ok");
      assert.ok(!("code" in result) && !("data" in result), "envelope keys must not leak");
    },
  ));

// ── 8. Client-side validation failures are ParamError, and never touched the wire
test("metadata failure: local payload validation throws ParamError without any HTTP call", () =>
  withStubbedFetch(
    () => assert.fail("validation failures must not issue an HTTP request"),
    async (calls) => {
      const client = makeClient();

      const payloadError = (() => {
        try {
          client.createUser(undefined);
        } catch (e) {
          return e;
        }
        return assert.fail("createUser(undefined) must throw");
      })();
      assertTypedFailure(payloadError, { name: "ParamError" });
      assert.ok(payloadError instanceof TypeError);
      assert.match(payloadError.message, /request payload must be an object/);

      const listTeamsError = (() => {
        try {
          client.listTeams({});
        } catch (e) {
          return e;
        }
        return assert.fail("listTeams({}) must throw");
      })();
      assertTypedFailure(listTeamsError, { name: "ParamError" });
      assert.match(listTeamsError.message, /listTeams requires one of user_id, user_key/);

      const listTasksError = (() => {
        try {
          client.listTasks({});
        } catch (e) {
          return e;
        }
        return assert.fail("listTasks({}) must throw");
      })();
      assertTypedFailure(listTasksError, { name: "ParamError" });
      assert.match(
        listTasksError.message,
        /listTasks requires one of team_id, creator_user_id, creator_user_key/,
      );

      const configError = (() => {
        try {
          new MetadataClient({ endpoint: "https://memory.example.test", apiKey: "", serviceId: "svc-1" });
        } catch (e) {
          return e;
        }
        return assert.fail("missing apiKey must throw");
      })();
      assertTypedFailure(configError, { name: "ParamError" });
      assert.match(configError.message, /apiKey must be provided/);

      assert.equal(calls.length, 0, "no metadata request may be sent for local validation failures");
    },
  ));

// ── 9. Sibling client (prompt) shares the same normalized failure surface ──
test("prompt client failure: the sibling client exposes the same typed TDAMError", () =>
  withStubbedFetch(
    () => json(500, { code: 42007, message: "prompt missing", request_id: "srv-p1" },
      { "x-qcloud-transaction-id": "txn-p" }),
    async (calls) => {
      const promptClient = new MemoryPromptClient({
        endpoint: "https://memory.example.test",
        apiKey: "kernel-token",
        serviceId: "svc-1",
        teamId: "t1",
      });
      const error = await promptClient.get("p1").then(
        () => assert.fail("prompt get must reject"),
        (e) => e,
      );
      assertTypedFailure(error, { name: "TDAMError", code: 42007 });
      assert.equal(error.requestId, "txn-p");
      assert.match(calls[0].url, /\/v3\/memory-prompt\/get\?memory_prompt_id=p1/);
    },
  ));

// ── 10. Injected transports: a typed failure is passed through unwrapped ──
test("metadata failure: an injected transport's TDAMError propagates unchanged", async () => {
  const sentinel = new TDAMError(40001, "injected failure", "rid-1", { hint: "typed" });
  const client = new MetadataClient({ post: () => Promise.reject(sentinel) });
  const error = await client.getUser("u1").then(
    () => assert.fail("getUser must reject"),
    (e) => e,
  );
  assert.equal(error, sentinel, "typed failure must not be re-wrapped or re-shaped");
  assertTypedFailure(error, { name: "TDAMError", code: 40001 });
  assert.deepEqual(error.details, { hint: "typed" });
});
