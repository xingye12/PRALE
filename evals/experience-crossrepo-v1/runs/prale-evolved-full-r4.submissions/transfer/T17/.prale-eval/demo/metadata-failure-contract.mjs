#!/usr/bin/env node
/**
 * Contract demo — T17 (tdam, mode: contract)
 *
 * "Contract a different metadata or prompt client failure: assert it exposes a
 *  typed/normalized failure instead of leaking a raw response shape."
 *
 * This script loads the REAL, unmodified `MetadataClient` from
 * `sdk/memory-core/typescript/src/v3/metadata-client.ts` (via Node's native
 * TypeScript type stripping + the `.prale-eval/demo/loader.mjs` resolve hook),
 * wires it to an in-process `fetch` stub, and asserts the *client contract*
 * around failures and results:
 *
 *   1. A server-side failure (business `code !== 0` inside an HTTP 200
 *      envelope, an HTTP error status, or a non-JSON body) is surfaced as a
 *      typed/normalized `TDAMError` — numeric `.code`, string `.requestId`,
 *      structured `.details` — and NOT as the raw envelope
 *      `{ code, message, request_id, data }`.
 *   2. A client-side argument failure is surfaced as a typed `ParamError`
 *      (a `TypeError` subclass), not as a raw response.
 *   3. A successful call resolves to the normalized operation result
 *      (`envelope.data` + `trace_id`); the envelope keys `code` / `message` /
 *      `request_id` are not leaked onto the result.
 *
 * The demo never touches the network: `globalThis.fetch` is replaced with a
 * stub that replays canned `Response` objects, so the only code exercised is
 * the SDK's own request/validation/error path.
 *
 * Exit code 0 iff every contract case passes.
 */

import assert from "node:assert/strict";

import {
  MetadataClient,
} from "../../sdk/memory-core/typescript/src/v3/metadata-client.ts";
import { ParamError, TDAMError } from "../../sdk/memory-core/typescript/src/errors.ts";

const ENDPOINT = "http://127.0.0.1:8420";

/** Install a canned fetch response for the next request. */
function stubFetch({ status = 200, body = "", headers = {} } = {}) {
  globalThis.fetch = async () => {
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
}

function client() {
  return new MetadataClient({ endpoint: ENDPOINT, apiKey: "test-token", serviceId: "svc-1" });
}

/** Capture the rejection raised by `fn` (fails if it resolves). */
async function rejectionOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function isPlainEnvelopeShape(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    "message" in value &&
    "request_id" in value
  );
}

const cases = [];
async function contractCase(name, fn) {
  const record = { case: name, pass: false };
  try {
    record.detail = await fn();
    record.pass = true;
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  cases.push(record);
}

// ───────────────────────── contract cases ─────────────────────────

await contractCase("business_error_envelope_is_normalized_not_leaked", async () => {
  const envelope = {
    code: 40901,
    message: "prompt version stale",
    request_id: "req-body-1",
    data: { current_version: 7 },
  };
  stubFetch({
    status: 200,
    body: JSON.stringify(envelope),
    headers: { "x-qcloud-transaction-id": "txn-hdr-1" },
  });

  const err = await rejectionOf(() => client().getUserKey("uk-1"));

  // Typed / normalized failure surface.
  assert.ok(err instanceof TDAMError, "expected TDAMError");
  assert.ok(err instanceof Error, "expected an Error subclass");
  assert.equal(err.name, "TDAMError");
  assert.equal(typeof err.code, "number");
  assert.equal(err.code, 40901);
  assert.equal(err.requestId, "txn-hdr-1");
  assert.deepEqual(err.details, { current_version: 7 });
  assert.equal(err.message, "[40901] prompt version stale (request_id=txn-hdr-1)");

  // The raw response shape must NOT be the thrown value.
  assert.equal(isPlainEnvelopeShape(err), false, "raw envelope shape leaked");
  assert.equal(Object.prototype.hasOwnProperty.call(err, "request_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(err, "data"), false);
  assert.notEqual(err.code, "40901");
  return { code: err.code, requestId: err.requestId, details: err.details };
});

await contractCase("request_id_falls_back_to_envelope_when_no_trace_header", async () => {
  stubFetch({
    status: 200,
    body: JSON.stringify({ code: 40301, message: "forbidden", request_id: "req-body-2", data: null }),
  });

  const err = await rejectionOf(() => client().verifyAuth("uk-2"));
  assert.ok(err instanceof TDAMError);
  assert.equal(err.code, 40301);
  assert.equal(err.requestId, "req-body-2");
  assert.equal(err.details, undefined);
  return { code: err.code, requestId: err.requestId };
});

await contractCase("http_error_status_is_normalized_to_numeric_code", async () => {
  stubFetch({ status: 500, body: JSON.stringify({}) });

  const err = await rejectionOf(() => client().listUsers("team-1"));
  assert.ok(err instanceof TDAMError);
  assert.equal(err.code, 500);
  assert.equal(err.message, "[500] HTTP 500 (request_id=)");
  return { code: err.code };
});

await contractCase("non_json_success_body_is_normalized", async () => {
  stubFetch({ status: 200, body: "<html>not json</html>" });

  const err = await rejectionOf(() => client().listTeamMembers("team-1"));
  assert.ok(err instanceof TDAMError);
  assert.equal(err.code, -1);
  assert.match(err.message, /not json/);
  return { code: err.code };
});

await contractCase("non_json_http_error_body_is_normalized", async () => {
  stubFetch({ status: 502, body: "<html>bad gateway</html>" });

  const err = await rejectionOf(() => client().createKnowledge({ knowledge_id: "k", type: "wiki" }));
  assert.ok(err instanceof TDAMError);
  assert.equal(err.code, 502);
  return { code: err.code };
});

await contractCase("missing_api_key_is_typed_param_error", async () => {
  const err = await rejectionOf(() => new MetadataClient({ endpoint: ENDPOINT, apiKey: "", serviceId: "svc-1" }));
  assert.ok(err instanceof ParamError);
  assert.ok(err instanceof TypeError);
  assert.equal(err.name, "ParamError");
  assert.equal(err.message, "apiKey must be provided");
  return { name: err.name, message: err.message };
});

await contractCase("invalid_endpoint_is_typed_param_error", async () => {
  const err = await rejectionOf(() => new MetadataClient({ endpoint: "not-a-url", apiKey: "k", serviceId: "svc-1" }));
  assert.ok(err instanceof ParamError);
  assert.equal(err.message, "endpoint must be a valid HTTP(S) URL");
  return { name: err.name, message: err.message };
});

await contractCase("non_object_request_payload_is_typed_param_error", async () => {
  const err = await rejectionOf(() => client().createUser(null));
  assert.ok(err instanceof ParamError);
  assert.equal(err.message, "request payload must be an object");
  return { name: err.name, message: err.message };
});

await contractCase("list_tasks_without_any_selector_is_typed_param_error", async () => {
  stubFetch({ status: 200, body: JSON.stringify({ code: 0, message: "ok", request_id: "r", data: {} }) });
  const err = await rejectionOf(() => client().listTasks({}));
  assert.ok(err instanceof ParamError);
  assert.equal(err.message, "listTasks requires one of team_id, creator_user_id, creator_user_key");
  return { name: err.name, message: err.message };
});

await contractCase("success_resolves_to_normalized_operation_result", async () => {
  stubFetch({
    status: 200,
    body: JSON.stringify({
      code: 0,
      message: "ok",
      request_id: "req-9",
      data: { user_id: "u1", status: "active" },
    }),
    headers: { "x-trace-id": "trace-9" },
  });

  const result = await client().getUser("u1");
  assert.deepEqual(result, { user_id: "u1", status: "active", trace_id: "trace-9" });
  // Envelope metadata must not leak onto the normalized result.
  assert.equal(Object.prototype.hasOwnProperty.call(result, "code"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "message"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "request_id"), false);
  return result;
});

// ─────────────────── boundary probes (documentation) ───────────────────
// Recorded for transparency; deliberately NOT part of the passing contract.
// The failure contract above covers envelopes with a non-zero code / non-OK
// HTTP status. A malformed *success* envelope (code 0 with a non-object
// `data`) is passed through unchanged by V3HttpTransport.request, which only
// asserts the envelope is parseable JSON, not that `data` is an object.
const boundaryProbes = [];
async function boundaryProbe(name, fn) {
  try {
    boundaryProbes.push({ probe: name, observed: await fn() });
  } catch (err) {
    boundaryProbes.push({ probe: name, observed: `rejected: ${err?.name}: ${err?.message}` });
  }
}

await boundaryProbe("code0_with_primitive_data_passthrough", async () => {
  stubFetch({ status: 200, body: JSON.stringify({ code: 0, message: "ok", request_id: "r", data: "RAW" }) });
  return await client().getUser("u1");
});

await boundaryProbe("code0_with_array_data_passthrough", async () => {
  stubFetch({ status: 200, body: JSON.stringify({ code: 0, message: "ok", request_id: "r", data: [1, 2, 3] }) });
  return await client().getUser("u1");
});

// ───────────────────────────── report ─────────────────────────────

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
};

console.log(JSON.stringify({
  task: "T17",
  contract: "metadata client failures are typed/normalized (TDAMError/ParamError), never the raw response shape",
  loadedFrom: "sdk/memory-core/typescript/src/v3/metadata-client.ts (unmodified, native type stripping)",
  cases,
  boundary_probes: boundaryProbes,
  summary,
}, null, 2));

process.exit(summary.failed === 0 ? 0 : 1);
