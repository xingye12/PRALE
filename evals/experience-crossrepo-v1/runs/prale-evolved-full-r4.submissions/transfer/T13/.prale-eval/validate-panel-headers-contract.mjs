/**
 * Dependency-free static contract validator (Task T13, repository `tdam`).
 *
 * Rationale: the focused runtime validation is the vitest demo at
 * MemoryPanel/tests/panel/validate-panel-headers.contract.test.ts, which needs
 * the workspace dependencies (hono, zod, vitest). Those are NOT installed in
 * this checkout, so per engineering doctrine we do not install them and instead
 * run a limited-strength static assertion over the real sources.
 *
 * Run:  node .prale-eval/validate-panel-headers-contract.mjs
 * Exits 0 when every assertion holds, 1 otherwise; prints a JSON report.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

const middleware = read('MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts');
const headers = read('MemoryPanel/src/panel/kernel/headers.ts');
const envelope = read('MemoryPanel/src/panel/http/envelope.ts');
const taskRoute = read('MemoryPanel/src/panel/http/routes/task.ts');

const checks = [];
const check = (name, condition, detail) => checks.push({ name, ok: !!condition, detail });

// 1. Required header names are the single source of truth used by the middleware.
check(
  'headers: META_HEADER_SERVICE_ID = x-tdai-service-id',
  /META_HEADER_SERVICE_ID\s*=\s*'x-tdai-service-id'/.test(headers),
  'MemoryPanel/src/panel/kernel/headers.ts:5',
);
check(
  'headers: META_HEADER_USER_KEY = x-tdai-user-key',
  /META_HEADER_USER_KEY\s*=\s*'x-tdai-user-key'/.test(headers),
  'MemoryPanel/src/panel/kernel/headers.ts:6',
);

// 2. Middleware reads both headers and emits the three control codes.
check(
  'middleware: reads service-id header',
  /c\.req\.header\(META_HEADER_SERVICE_ID\)/.test(middleware),
  'validate-panel-headers.ts:34',
);
check(
  'middleware: emits 400 MISSING_INSTANCE_ID',
  /respondControlError\(c,\s*400,\s*'MISSING_INSTANCE_ID'\)/.test(middleware),
  'validate-panel-headers.ts:36',
);
check(
  'middleware: emits 400 INVALID_INSTANCE for unknown instance',
  /respondControlError\(c,\s*400,\s*'INVALID_INSTANCE'\)/.test(middleware),
  'validate-panel-headers.ts:44',
);
check(
  'middleware: reads user-key header',
  /c\.req\.header\(META_HEADER_USER_KEY\)/.test(middleware),
  'validate-panel-headers.ts:50',
);
check(
  'middleware: emits 400 MISSING_USER_KEY when user key absent (non auth/verify action)',
  /respondControlError\(c,\s*400,\s*'MISSING_USER_KEY'\)/.test(middleware),
  'validate-panel-headers.ts:52',
);

// 3. Every rejection returns before downstream work: next() must appear only
//    after all validation, and control errors must be `return`ed.
check(
  'middleware: all three control errors are returned early',
  (middleware.match(/return respondControlError\(/g) ?? []).length === 3,
  'validate-panel-headers.ts:36,44,52',
);
const nextIdx = middleware.indexOf('await next()');
const missingUserKeyIdx = middleware.indexOf("'MISSING_USER_KEY'");
check(
  'middleware: await next() is textually after the last guard (no downstream call on rejection)',
  nextIdx > -1 && nextIdx > missingUserKeyIdx,
  'validate-panel-headers.ts:61',
);
check(
  'middleware: panelMeta context is set only after guards',
  middleware.indexOf("c.set('panelMeta'") > missingUserKeyIdx,
  'validate-panel-headers.ts:55',
);

// 4. Standard envelope shape + HTTP status mapping.
check(
  'envelope: controlEnvelope has code/message/request_id/data',
  /code,/.test(envelope) && /message,/.test(envelope) && /request_id: requestId,/.test(envelope) && /data: null,/.test(envelope),
  'MemoryPanel/src/panel/http/envelope.ts:10-15',
);
check(
  'envelope: respondControlError uses request id from context',
  /respondControlError[\s\S]*c\.get\('reqId'\)/.test(envelope),
  'MemoryPanel/src/panel/http/envelope.ts:22-25',
);
check(
  'envelope: 400 maps to HTTP 400',
  /if \(code >= 400 && code < 600\) return code;/.test(read('MemoryPanel/src/panel/kernel/envelope.ts')),
  'MemoryPanel/src/panel/kernel/envelope.ts:12',
);

// 5. Contracted route actually mounts the middleware before its handler.
check(
  'route: POST /task/list-with-agents mounts validatePanelMetaHeaders',
  /api\.post\(\s*"\/task\/list-with-agents",\s*validatePanelMetaHeaders\(deps\),/.test(taskRoute),
  'MemoryPanel/src/panel/http/routes/task.ts:82-84',
);

const failed = checks.filter((c) => !c.ok);
const report = {
  validator: 'validate-panel-headers-contract.mjs',
  route: 'POST /api/v1/task/list-with-agents',
  checks: checks.length,
  passed: checks.length - failed.length,
  failed: failed.map((c) => c.name),
  results: checks,
  limitations: [
    'vitest/hono/zod are not installed in this checkout, so the runtime test',
    'MemoryPanel/tests/panel/validate-panel-headers.contract.test.ts could not be executed.',
    'This static assertion is the limited-strength substitute; logic is verified',
    'textually over the real sources, not executed.',
  ].join(' '),
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
