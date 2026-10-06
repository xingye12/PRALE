/**
 * Fake-client operation test — InstanceConfigProvider.
 *
 * Contract under test (the public core surface re-exported by
 * `src/core/index.ts` as `InstanceConfigProvider`):
 *
 *   1. NO SUCCESS STATE IS COMMITTED BEFORE THE CLIENT EFFECT COMPLETES.
 *      `resolveVdb(instanceId)` reads through an injected `IConfigSource`
 *      (the "client"). The VDB cache entry — the provider's success state,
 *      observable via `poolSize` / the cache-hit fast path — must not exist
 *      while the client's fetch promise is still pending.
 *
 *   2. FAILURE REMAINS OBSERVABLE.
 *      A rejecting client fetch must reject `resolveVdb` (not be swallowed
 *      into a cached success), must leave the cache empty, and must not
 *      strand the instance behind a stale in-flight marker so a later retry
 *      can still reach the client.
 *
 * The fake client is deliberately manual: the test owns when the effect
 * settles, so "before the effect completes" is an observable instant rather
 * than a race.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceConfigProvider } from "../instance-config-provider.js";
import type { VdbConfig, CosConfig } from "../instance-config-provider.js";
import type { IConfigSource } from "../abstractions/index.js";

// ────────────────────────────────────────────────────────
// Fakes & helpers
// ────────────────────────────────────────────────────────

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const VDB: VdbConfig = {
  url: "http://vdb.test:80",
  user: "root",
  apiKey: "test-key",
  database: "test-db",
};

interface PendingEffect {
  resolve: (value: VdbConfig) => void;
  reject: (error: unknown) => void;
}

/**
 * Fake client implementing the real `IConfigSource` contract.
 *
 * `fetchVdb` never settles on its own — the test calls `completeEffect()`
 * or `failEffect()` to drive the effect. That is what makes "success state
 * must not be committed before the effect completes" observable.
 */
class FakeConfigClient implements IConfigSource {
  fetchVdbCalls = 0;
  private pending: PendingEffect[] = [];

  fetchVdb(_instanceId: string): Promise<VdbConfig> {
    this.fetchVdbCalls += 1;
    return new Promise<VdbConfig>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  async fetchCos(): Promise<CosConfig | null> {
    return null;
  }

  /** The fake effect completes successfully. */
  completeEffect(value: VdbConfig = VDB): void {
    const effect = this.pending.shift();
    if (!effect) throw new Error("completeEffect() called with no in-flight fetch");
    effect.resolve(value);
  }

  /** The fake effect fails. */
  failEffect(error: Error): void {
    const effect = this.pending.shift();
    if (!effect) throw new Error("failEffect() called with no in-flight fetch");
    effect.reject(error);
  }

  get inFlight(): number {
    return this.pending.length;
  }
}

/** A client that resolves a payload the provider must treat as unusable. */
class EmptyPayloadClient implements IConfigSource {
  async fetchVdb(): Promise<VdbConfig> {
    return {} as VdbConfig;
  }
  async fetchCos(): Promise<CosConfig | null> {
    return null;
  }
}

function makeProvider(client: IConfigSource): InstanceConfigProvider {
  return new InstanceConfigProvider({ source: client, logger: silentLogger });
}

// ────────────────────────────────────────────────────────
// 1. No success state before the fake effect completes
// ────────────────────────────────────────────────────────

describe("InstanceConfigProvider fake client — commit gating", () => {
  it("commits no cache entry while the client effect is still pending", async () => {
    const client = new FakeConfigClient();
    const provider = makeProvider(client);

    const resolving = provider.resolveVdb("inst-pending");

    // The client was reached, and its effect is in flight.
    expect(client.inFlight).toBe(1);

    // Success state (the VDB cache) must still be empty.
    expect(provider.poolSize).toBe(0);

    // Drain microtasks: a premature `cache.set()` would land here.
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.poolSize).toBe(0);
    expect(client.inFlight).toBe(1);

    // Effect completes → only now is success committed.
    client.completeEffect(VDB);
    await expect(resolving).resolves.toEqual(VDB);
    expect(provider.poolSize).toBe(1);
  });

  it("shares one in-flight effect for concurrent callers but commits once, after it completes", async () => {
    const client = new FakeConfigClient();
    const provider = makeProvider(client);

    const first = provider.resolveVdb("inst-dedupe");
    const second = provider.resolveVdb("inst-dedupe");

    // H-2 dedupe: one effect, not two.
    expect(client.fetchVdbCalls).toBe(1);
    expect(provider.poolSize).toBe(0);

    client.completeEffect(VDB);
    await expect(Promise.all([first, second])).resolves.toEqual([VDB, VDB]);
    expect(provider.poolSize).toBe(1);
  });

  // ────────────────────────────────────────────────────
  // 2. Failure stays observable
  // ────────────────────────────────────────────────────

  it("propagates a failing client effect instead of caching a success", async () => {
    const client = new FakeConfigClient();
    const provider = makeProvider(client);

    const resolving = provider.resolveVdb("inst-fail");
    expect(provider.poolSize).toBe(0);

    client.failEffect(new Error("config source unreachable"));

    await expect(resolving).rejects.toThrow("config source unreachable");
    // The failure left no success state behind.
    expect(provider.poolSize).toBe(0);
  });

  it("does not strand the instance: after a failure a retry reaches the client and can commit", async () => {
    const client = new FakeConfigClient();
    const provider = makeProvider(client);

    const firstAttempt = provider.resolveVdb("inst-retry");
    client.failEffect(new Error("transient boom"));
    await expect(firstAttempt).rejects.toThrow("transient boom");

    // The in-flight marker was cleared in `finally`, so a retry re-issues
    // the client operation rather than awaiting a permanently rejected one.
    const secondAttempt = provider.resolveVdb("inst-retry");
    expect(client.fetchVdbCalls).toBe(2);
    expect(provider.poolSize).toBe(0);

    client.completeEffect(VDB);
    await expect(secondAttempt).resolves.toEqual(VDB);
    expect(provider.poolSize).toBe(1);
  });

  it("surfaces an unusable client payload as an observable failure with no cached state", async () => {
    const provider = makeProvider(new EmptyPayloadClient());

    await expect(provider.resolveVdb("inst-empty")).rejects.toThrow(/empty VDB config/);
    expect(provider.poolSize).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// 3. The public core barrel really exposes this operation
// ────────────────────────────────────────────────────────

describe("core barrel contract", () => {
  it("re-exports InstanceConfigProvider from src/core/index.ts", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const barrel = readFileSync(path.join(here, "..", "index.ts"), "utf-8");
    expect(barrel).toMatch(/export\s*\{[^}]*\bInstanceConfigProvider\b[^}]*\}/s);
  });
});
