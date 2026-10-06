import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TDAMError } from "../../src/errors.js";
import { V3HttpTransport } from "../../src/v3/http.js";

interface MalformedCase {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  expect: { name: string; code: number; message: string; requestId: string };
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/v3/malformed-error-envelope.json", import.meta.url), "utf8"),
) as { request: { path: string; body: Record<string, unknown> }; cases: MalformedCase[] };

function makeTransport(): V3HttpTransport {
  return new V3HttpTransport({
    endpoint: "http://memory-gateway.test",
    apiKey: "test-key",
    serviceId: "svc-test",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("v3 transport / malformed error envelope", () => {
  for (const c of fixture.cases) {
    it(`normalizes ${c.name} to a TDAMError`, async () => {
      vi.stubGlobal("fetch", async () =>
        new Response(c.body, { status: c.status, headers: c.headers }),
      );

      const promise = makeTransport().post(fixture.request.path, fixture.request.body);
      await expect(promise).rejects.toBeInstanceOf(TDAMError);
      const err = (await promise.catch((e) => e)) as TDAMError;

      expect(err.name).toBe(c.expect.name);
      expect(err.code).toBe(c.expect.code);
      expect(err.requestId).toBe(c.expect.requestId);
      // TDAMError formats its message as `[code] message (request_id=...)`.
      expect(err.message).toBe(
        `[${c.expect.code}] ${c.expect.message} (request_id=${c.expect.requestId})`,
      );
    });
  }

  it("does not crash with a TypeError on a null body", async () => {
    vi.stubGlobal("fetch", async () => new Response("null", { status: 200 }));
    const err = await makeTransport()
      .post(fixture.request.path, fixture.request.body)
      .catch((e) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("still unwraps a well-formed success envelope", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: 0, message: "ok", request_id: "r-1", data: { hit: 1 } }), {
        status: 200,
        headers: { "x-trace-id": "trace-ok" },
      }),
    );
    const data = await makeTransport().post<{ hit: number }>(
      fixture.request.path,
      fixture.request.body,
    );
    expect(data.hit).toBe(1);
    expect(data.trace_id).toBe("trace-ok");
  });
});
