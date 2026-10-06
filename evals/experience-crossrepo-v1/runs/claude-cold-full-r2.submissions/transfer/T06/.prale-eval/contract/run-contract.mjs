/**
 * Executable contract: metadata / memory-prompt client failures must surface as
 * typed, normalized failures (TDAMError / ParamError) and must never leak a raw
 * HTTP response shape (a raw TypeError, or a bare primitive/array returned as if
 * it were the requested entity).
 *
 * Runs the real TypeScript sources directly under Node (type stripping) via the
 * sibling loader hook, which only shims the uninstalled `undici` bare specifier.
 *
 *   node --import ./.prale-eval/contract/register.mjs \
 *        ./.prale-eval/contract/run-contract.mjs
 */
import assert from "node:assert/strict";
import { MetadataClient } from "../../sdk/memory-core/typescript/src/v3/metadata-client.ts";
import { MemoryPromptClient } from "../../sdk/memory-core/typescript/src/v3/memory-prompt-client.ts";
import { TDAMError, ParamError } from "../../sdk/memory-core/typescript/src/errors.ts";

const CONFIG = { endpoint: "https://memory.example.com", apiKey: "token", serviceId: "svc" };
const metadata = new MetadataClient(CONFIG);
const prompts = new MemoryPromptClient(CONFIG);

/** Install a one-shot global fetch that replays a canned HTTP response. */
function respondWith(body, status = 200, headers = {}) {
  globalThis.fetch = async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

let passed = 0;
const failures = [];

async function contract(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

/** Assert `promise` rejects with a TDAMError carrying the expected normalized fields. */
async function rejectsNormalized(promise, { code, requestId } = {}) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected the operation to reject, but it resolved");
  assert.ok(
    caught instanceof TDAMError,
    `expected a normalized TDAMError, got ${caught.constructor.name}: ${caught.message}`,
  );
  assert.ok(
    !(caught instanceof TypeError),
    "leaked a raw JS TypeError instead of a normalized failure",
  );
  assert.equal(caught.name, "TDAMError");
  if (code !== undefined) assert.equal(caught.code, code);
  if (requestId !== undefined) assert.equal(caught.requestId, requestId);
  return caught;
}

console.log("metadata client — already-normalized failure shapes");
await contract("business code !== 0 rejects with TDAMError(code, requestId)", async () => {
  respondWith(JSON.stringify({ code: 40003, message: "user not found", request_id: "env-1" }));
  const err = await rejectsNormalized(metadata.getUser("u1"), { code: 40003, requestId: "env-1" });
  assert.equal(err.message, "[40003] user not found (request_id=env-1)");
});

await contract("envelope data on an error is preserved as typed details", async () => {
  respondWith(JSON.stringify({ code: 40901, message: "stale", data: { current_version: 7 } }));
  const err = await rejectsNormalized(metadata.getUser("u1"), { code: 40901 });
  assert.deepEqual(err.details, { current_version: 7 });
});

await contract("non-JSON HTTP 500 rejects with TDAMError(500), not a raw Response", async () => {
  respondWith("upstream exploded", 500);
  const err = await rejectsNormalized(metadata.getUser("u1"), { code: 500 });
  assert.ok(err.message.includes("upstream exploded"));
});

await contract("request id prefers the transport header over the envelope", async () => {
  respondWith(JSON.stringify({ code: 1, message: "x" }), 200, {
    "x-qcloud-transaction-id": "hdr-9",
  });
  await rejectsNormalized(metadata.getUser("u1"), { code: 1, requestId: "hdr-9" });
});

console.log("metadata client — envelope-shape failures (the contracted leak)");
await contract("JSON null envelope rejects with TDAMError, not a raw TypeError", async () => {
  respondWith("null");
  await rejectsNormalized(metadata.getUser("u1"), { code: -1 });
});

await contract("JSON null envelope over HTTP 500 still normalizes", async () => {
  respondWith("null", 500);
  await rejectsNormalized(metadata.getUser("u1"), { code: -1 });
});

await contract("primitive JSON envelope rejects instead of leaking the value", async () => {
  respondWith('"boom"');
  await rejectsNormalized(metadata.getUser("u1"), { code: -1 });
});

await contract("non-object success data rejects instead of returning a raw primitive", async () => {
  respondWith(JSON.stringify({ code: 0, data: "raw-string" }));
  await rejectsNormalized(metadata.getUser("u1"), { code: -1 });
});

await contract("numeric success data rejects instead of returning a raw number", async () => {
  respondWith(JSON.stringify({ code: 0, data: 7 }));
  await rejectsNormalized(metadata.getUser("u1"), { code: -1 });
});

await contract("array success data rejects instead of returning a raw array", async () => {
  respondWith(JSON.stringify({ code: 0, data: [1, 2] }));
  await rejectsNormalized(metadata.listUsers({ team_id: "t1" }), { code: -1 });
});

await contract("well-formed success still resolves with the typed entity", async () => {
  respondWith(JSON.stringify({ code: 0, data: { user_id: "u1", name: "Ada" } }), 200, {
    "x-trace-id": "trace-1",
  });
  const user = await metadata.getUser("u1");
  assert.deepEqual(user, { user_id: "u1", name: "Ada", trace_id: "trace-1" });
});

console.log("memory-prompt client — same transport, same normalization");
await contract("JSON null envelope rejects with TDAMError, not a raw TypeError", async () => {
  respondWith("null");
  await rejectsNormalized(prompts.get("mp-1"), { code: -1 });
});

await contract("non-object success data rejects instead of returning a raw primitive", async () => {
  respondWith(JSON.stringify({ code: 0, data: "raw-string" }));
  await rejectsNormalized(prompts.get("mp-1"), { code: -1 });
});

await contract("invalid parameters reject with the typed ParamError", async () => {
  let caught;
  try {
    await prompts.getEffective({});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParamError, `expected ParamError, got ${caught && caught.constructor.name}`);
  assert.ok(!(caught instanceof TDAMError));
  assert.equal(caught.name, "ParamError");
});

console.log(`\n${passed}/${passed + failures.length} contract assertions passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} contract assertion(s) failed.`);
  process.exitCode = 1;
}
