/**
 * Executable demo of the fake-client operation contract for
 * InstanceConfigProvider (public surface: MemoryCore/src/core/index.ts).
 *
 * Runs the same assertions as
 * MemoryCore/src/core/__tests__/instance-config-provider.fake-client.test.ts,
 * but with plain Node + node:assert, so it needs no node_modules.
 *
 *   node --experimental-transform-types .prale-eval/run-fake-client-demo.mjs
 */
import { register } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./ts-resolve.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.join(here, "..", "MemoryCore", "src", "core");

const { InstanceConfigProvider } = await import(
  path.join(coreSrc, "instance-config-provider.ts")
);

// ── fakes ────────────────────────────────────────────────

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const VDB = { url: "http://vdb.test:80", user: "root", apiKey: "test-key", database: "test-db" };

class FakeConfigClient {
  fetchVdbCalls = 0;
  pending = [];
  fetchVdb() {
    this.fetchVdbCalls += 1;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  async fetchCos() {
    return null;
  }
  completeEffect(value = VDB) {
    this.pending.shift().resolve(value);
  }
  failEffect(error) {
    this.pending.shift().reject(error);
  }
  get inFlight() {
    return this.pending.length;
  }
}

class EmptyPayloadClient {
  async fetchVdb() {
    return {};
  }
  async fetchCos() {
    return null;
  }
}

const make = (source) => new InstanceConfigProvider({ source, logger: silentLogger });

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err?.message}`);
    throw err;
  }
}

// ── 1. no success state before the fake effect completes ─

console.log("InstanceConfigProvider fake client — commit gating");

await check("no cache entry while the client effect is pending", async () => {
  const client = new FakeConfigClient();
  const provider = make(client);

  const resolving = provider.resolveVdb("inst-pending");
  assert.equal(client.inFlight, 1, "client effect should be in flight");
  assert.equal(provider.poolSize, 0, "no success state before effect completes");

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(provider.poolSize, 0, "no success state after microtask drain");
  assert.equal(client.inFlight, 1);

  client.completeEffect(VDB);
  assert.deepEqual(await resolving, VDB);
  assert.equal(provider.poolSize, 1, "success committed only after effect completes");
});

await check("concurrent callers share one effect, commit once after it completes", async () => {
  const client = new FakeConfigClient();
  const provider = make(client);

  const first = provider.resolveVdb("inst-dedupe");
  const second = provider.resolveVdb("inst-dedupe");
  assert.equal(client.fetchVdbCalls, 1, "in-flight dedupe");
  assert.equal(provider.poolSize, 0);

  client.completeEffect(VDB);
  assert.deepEqual(await Promise.all([first, second]), [VDB, VDB]);
  assert.equal(provider.poolSize, 1);
});

// ── 2. failure remains observable ────────────────────────

await check("a failing client effect rejects and caches nothing", async () => {
  const client = new FakeConfigClient();
  const provider = make(client);

  const resolving = provider.resolveVdb("inst-fail");
  assert.equal(provider.poolSize, 0);
  client.failEffect(new Error("config source unreachable"));

  await assert.rejects(resolving, /config source unreachable/);
  assert.equal(provider.poolSize, 0, "failure committed no success state");
});

await check("after failure a retry reaches the client and can succeed", async () => {
  const client = new FakeConfigClient();
  const provider = make(client);

  const first = provider.resolveVdb("inst-retry");
  client.failEffect(new Error("transient boom"));
  await assert.rejects(first, /transient boom/);

  const second = provider.resolveVdb("inst-retry");
  assert.equal(client.fetchVdbCalls, 2, "in-flight marker cleared on failure");
  assert.equal(provider.poolSize, 0);

  client.completeEffect(VDB);
  assert.deepEqual(await second, VDB);
  assert.equal(provider.poolSize, 1);
});

await check("unusable client payload surfaces as an observable failure", async () => {
  const provider = make(new EmptyPayloadClient());
  await assert.rejects(provider.resolveVdb("inst-empty"), /empty VDB config/);
  assert.equal(provider.poolSize, 0);
});

// ── 3. the public core barrel exposes the operation ──────

await check("src/core/index.ts re-exports InstanceConfigProvider", () => {
  const barrel = readFileSync(path.join(coreSrc, "index.ts"), "utf-8");
  assert.match(barrel, /export\s*\{[^}]*\bInstanceConfigProvider\b[^}]*\}/s);
});

console.log(`\nAll ${passed} checks passed.`);
