/**
 * Contract demo (Task T13): a Panel route guarded by `validatePanelMetaHeaders`
 * must, for missing/invalid required headers:
 *   1. return the standard control envelope (code / message / request_id / data), and
 *   2. never invoke the downstream (fake) kernel client.
 *
 * Route under contract: POST /api/v1/task/list-with-agents
 *   (Panel-layer aggregate route registered by `registerTaskRoutes`; distinct
 *   from the generic `/meta/*` transparent proxy and the `/skill/*` proxy.)
 *
 * Runner: vitest (repo canonical runner, `pnpm test`). Requires the workspace
 * dependencies (hono, zod) to be installed; see
 * `.prale-eval/contract-deliverable.md` for the dependency-free static
 * fallback used when they are absent.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerTaskRoutes } from '../../src/panel/http/routes/task.js';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import { META_HEADER_SERVICE_ID, META_HEADER_USER_KEY } from '../../src/panel/kernel/headers.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';

const ROUTE = '/api/v1/task/list-with-agents';

const OK_ENVELOPE: MetaEnvelope<unknown> = {
  code: 0,
  message: 'ok',
  request_id: 'downstream-req',
  data: { items: [], total: 0, limit: 50, offset: 0 },
};

interface Harness {
  request: (headers: Record<string, string>) => Promise<Response>;
  /** Fake downstream kernel client; records every invocation. */
  invoke: ReturnType<typeof vi.fn>;
}

function buildHarness(): Harness {
  const registry = new InstanceRegistry([
    {
      instance_id: 'local',
      name: 'local',
      gateway_endpoint: 'http://127.0.0.1:8420',
      api_key: 'fake-gateway-key',
    },
  ]);

  const invoke = vi.fn(async () => OK_ENVELOPE);
  const deps = {
    config: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => deps.logger,
    },
    instanceRegistry: registry,
    metaKernel: { invoke },
  } as unknown as PanelDeps;

  const app = new Hono();
  const api = new Hono();
  registerTaskRoutes(api, deps);
  app.route('/api/v1', api);

  const request = (headers: Record<string, string>) =>
    app.request(ROUTE, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'team-1' }),
    });

  return { request, invoke };
}

function assertControlEnvelope(body: unknown, expectedCode: number, expectedMessage: string): void {
  expect(body).toBeTypeOf('object');
  const env = body as Record<string, unknown>;
  expect(Object.keys(env).sort()).toEqual(['code', 'data', 'message', 'request_id']);
  expect(env.code).toBe(expectedCode);
  expect(env.message).toBe(expectedMessage);
  expect(env.data).toBeNull();
  expect(typeof env.request_id).toBe('string');
}

describe('POST /api/v1/task/list-with-agents — header contract', () => {
  it('missing x-tdai-service-id → 400 MISSING_INSTANCE_ID envelope, downstream untouched', async () => {
    const { request, invoke } = buildHarness();
    const res = await request({ [META_HEADER_USER_KEY]: 'user-key' });

    expect(res.status).toBe(400);
    assertControlEnvelope(await res.json(), 400, 'MISSING_INSTANCE_ID');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('unknown x-tdai-service-id → 400 INVALID_INSTANCE envelope, downstream untouched', async () => {
    const { request, invoke } = buildHarness();
    const res = await request({
      [META_HEADER_SERVICE_ID]: 'no-such-instance',
      [META_HEADER_USER_KEY]: 'user-key',
    });

    expect(res.status).toBe(400);
    assertControlEnvelope(await res.json(), 400, 'INVALID_INSTANCE');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('missing x-tdai-user-key → 400 MISSING_USER_KEY envelope, downstream untouched', async () => {
    const { request, invoke } = buildHarness();
    const res = await request({ [META_HEADER_SERVICE_ID]: 'local' });

    expect(res.status).toBe(400);
    assertControlEnvelope(await res.json(), 400, 'MISSING_USER_KEY');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blank (whitespace-only) headers are treated as missing', async () => {
    const { request, invoke } = buildHarness();
    const res = await request({
      [META_HEADER_SERVICE_ID]: '   ',
      [META_HEADER_USER_KEY]: '   ',
    });

    expect(res.status).toBe(400);
    assertControlEnvelope(await res.json(), 400, 'MISSING_INSTANCE_ID');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('positive control: valid headers reach the downstream client (envelope passed through)', async () => {
    const { request, invoke } = buildHarness();
    const res = await request({
      [META_HEADER_SERVICE_ID]: 'local',
      [META_HEADER_USER_KEY]: 'user-key',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_ENVELOPE);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('task/list');
  });
});
