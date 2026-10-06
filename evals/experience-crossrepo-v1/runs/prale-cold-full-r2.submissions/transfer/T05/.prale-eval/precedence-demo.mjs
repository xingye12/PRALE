#!/usr/bin/env node
/**
 * Executable precedence demo — MemoryPanel instance/panel configuration.
 *
 * Task: T05 (repository `tdam`, mode `contract`).
 *
 * What it does
 * ------------
 * Loads the REAL repository sources
 *   - MemoryPanel/src/panel/config/panel-config.ts   (loadPanelConfig / env / envInt / envBool)
 *   - MemoryPanel/src/panel/config/instance-registry.ts (InstanceRegistry.resolve / listPublic)
 *   - MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts (request-header layer)
 * and runs a precedence matrix where "explicit request input", "config" and "built-in default"
 * disagree, then emits a normalized JSON operation result.
 *
 * Why a shim is needed
 * --------------------
 * MemoryPanel declares `dotenv`, `zod` and `hono` as runtime dependencies, but this evaluation
 * workspace has no node_modules and installing dependencies is out of scope. The demo therefore:
 *   1. compiles the TypeScript away with the built-in `node:module.stripTypeScriptTypes`
 *      (`mode: 'transform'`, so parameter properties are lowered too),
 *   2. rewrites relative imports into reads from an in-process registry of the same repo
 *      modules (a `data:` URL module cannot resolve relative specifiers),
 *   3. replaces ONLY the third-party import statements with inert local stubs
 *      (`loadDotenv = () => {}`, a chainable proxy standing in for `z`, and
 *      `createMiddleware = (handler) => handler` for hono/factory, which is exactly what the
 *      middleware factory does), and
 *   4. imports the resulting module from a `data:` URL.
 * No repository file is modified; the semantics under test are the repository's own.
 * The shims are NOT exercised for their real behaviour: `loadDotenv()` only matters when a
 * `.env` file exists (there is none), `z` is only used by `InstanceRegistry.load()` (not called
 * here), and the Hono context is replaced by a three-method fake so that routing itself is out
 * of scope while the header-precedence logic inside the middleware stays real.
 *
 * Exit code: 0 when every precedence assertion holds, 1 otherwise.
 */
process.on('warning', () => {}); // silence the ExperimentalWarning for stripTypeScriptTypes

import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const SHIMS = {
  dotenv: 'const loadDotenv = () => {};',
  zod: [
    'const __zchain = new Proxy(function __z() {}, { get: () => __zchain, apply: () => __zchain });',
    'const z = new Proxy({}, { get: () => __zchain });',
  ].join('\n'),
  'hono/factory': 'const createMiddleware = (handler) => handler;',
};

const appliedShims = new Set();

// `data:` URL modules cannot resolve relative specifiers, so relative imports are rewritten to
// destructuring reads from a global registry that this loader populates depth-first.
const MODULE_KEY = '__PANEL_PRECEDENCE_DEMO_MODULES__';
const loaded = new Map();
if (!(MODULE_KEY in globalThis)) globalThis[MODULE_KEY] = {};

function resolveRepoPath(fromRepoPath, specifier) {
  const dir = path.posix.dirname(fromRepoPath);
  return path.posix.normalize(path.posix.join(dir, specifier)).replace(/\.js$/, '.ts');
}

async function loadRepoModule(relPath) {
  const key = relPath.replace(/\.js$/, '.ts');
  if (loaded.has(key)) return loaded.get(key);

  // `transform` (not `strip`) is required because InstanceRegistryError uses a
  // TypeScript parameter property (`readonly code: number`), which strip-only mode rejects.
  let code = stripTypeScriptTypes(readFileSync(path.join(REPO, key), 'utf8'), { mode: 'transform' });

  const pendingDeps = [];
  code = code.replace(
    /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm,
    (statement, names, specifier) => {
      if (specifier.startsWith('node:')) return statement;
      if (!specifier.startsWith('.')) {
        const shim = SHIMS[specifier];
        if (!shim) throw new Error(`no shim for third-party import '${specifier}' in ${key}`);
        appliedShims.add(specifier);
        return shim;
      }
      const depKey = resolveRepoPath(key, specifier);
      pendingDeps.push(depKey);
      const binding = names
        .split(',')
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => raw.replace(/\s+as\s+/, ': '))
        .join(', ');
      return `const { ${binding} } = globalThis[${JSON.stringify(MODULE_KEY)}][${JSON.stringify(depKey)}];`;
    },
  );

  for (const depKey of pendingDeps) await loadRepoModule(depKey);

  const namespace = await import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64'));
  globalThis[MODULE_KEY][key] = namespace;
  loaded.set(key, namespace);
  return namespace;
}

// ── environment layer harness ────────────────────────────────────────────────

const ENV_KEYS = [
  'HOST',
  'PORT',
  'METADATA_INSTANCES_CONFIG',
  'METADATA_REMOTE_TIMEOUT_MS',
  'UI_DIST_DIR',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'KNOWLEDGE_SERVICE_URL',
  'KNOWLEDGE_AUTH_TOKEN',
  'KNOWLEDGE_TIMEOUT_MS',
  'KNOWLEDGE_LLM_BINDING_SYNC',
  'KNOWLEDGE_LLM_PROXY_BASE_URL',
  'TDAI_AGENT_TEMPLATE_DIR',
];

function withEnv(overrides, fn) {
  const snapshot = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      const prev = snapshot.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// ── assertion helper ────────────────────────────────────────────────────────

const checks = [];
function check(id, layers, input, expected, actual, observation) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  checks.push({ id, layers, input, expected, actual, pass, observation });
  return pass;
}

// ── load real sources ───────────────────────────────────────────────────────

const panelConfigMod = await loadRepoModule('MemoryPanel/src/panel/config/panel-config.ts');
const instanceRegistryMod = await loadRepoModule('MemoryPanel/src/panel/config/instance-registry.ts');
const middlewareMod = await loadRepoModule('MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts');
const { loadPanelConfig } = panelConfigMod;
const { InstanceRegistry, InstanceRegistryError } = instanceRegistryMod;
const { validatePanelMetaHeaders } = middlewareMod;

// ── A. panel settings: explicit (request/env) input > config > built-in default

const DEFAULTS = withEnv({}, () => loadPanelConfig());
check(
  'A0',
  { explicit: 'unset', config: 'unset', default: 'built-in fallbacks' },
  {},
  {
    host: '0.0.0.0',
    port: 8123,
    metadataInstancesConfig: './config/metadata-instances.json',
    log: { level: 'info', format: 'json' },
    knowledgeBaseUrl: 'http://127.0.0.1:8421',
    knowledgeTimeoutMs: 15000,
    llmBindingSync: true,
  },
  {
    host: DEFAULTS.server.host,
    port: DEFAULTS.server.port,
    metadataInstancesConfig: DEFAULTS.metadataInstancesConfig,
    log: DEFAULTS.log,
    knowledgeBaseUrl: DEFAULTS.knowledge.baseUrl,
    knowledgeTimeoutMs: DEFAULTS.knowledge.timeoutMs,
    llmBindingSync: DEFAULTS.knowledgeLlmBinding.sync,
  },
  'Baseline: with no explicit input at all, loadPanelConfig() returns the built-in defaults baked into env()/envInt()/envBool().',
);

const explicitWins = withEnv(
  {
    HOST: '10.9.9.9',
    PORT: '9000',
    METADATA_INSTANCES_CONFIG: './config/instances.alt.json',
    KNOWLEDGE_LLM_BINDING_SYNC: 'false',
    LOG_LEVEL: 'debug',
  },
  () => loadPanelConfig(),
);
check(
  'A1',
  { explicit: 'HOST/PORT/METADATA_INSTANCES_CONFIG/KNOWLEDGE_LLM_BINDING_SYNC/LOG_LEVEL', config: 'same layer (env)', default: 'built-in fallbacks' },
  { HOST: '10.9.9.9', PORT: '9000', METADATA_INSTANCES_CONFIG: './config/instances.alt.json', KNOWLEDGE_LLM_BINDING_SYNC: 'false', LOG_LEVEL: 'debug' },
  { host: '10.9.9.9', port: 9000, metadataInstancesConfig: './config/instances.alt.json', llmBindingSync: false, level: 'debug' },
  {
    host: explicitWins.server.host,
    port: explicitWins.server.port,
    metadataInstancesConfig: explicitWins.metadataInstancesConfig,
    llmBindingSync: explicitWins.knowledgeLlmBinding.sync,
    level: explicitWins.log.level,
  },
  'Explicit input beats every built-in default, including the boolean default `sync: true` which an explicit "false" overrides.',
);

const blankNumeric = withEnv({ PORT: '', METADATA_REMOTE_TIMEOUT_MS: '' }, () => loadPanelConfig());
check(
  'A2',
  { explicit: 'PORT="" (blank)', config: 'same layer (env)', default: '8123 / 15000' },
  { PORT: '', METADATA_REMOTE_TIMEOUT_MS: '' },
  { port: 8123, metadataRemoteTimeoutMs: 15000 },
  { port: blankNumeric.server.port, metadataRemoteTimeoutMs: blankNumeric.metadataRemoteTimeoutMs },
  'Blank explicit input is treated as absent by envInt() (`raw === ""` -> fallback), so the default wins for numeric settings.',
);

const invalidNumeric = withEnv({ PORT: 'not-a-number' }, () => loadPanelConfig());
check(
  'A3',
  { explicit: 'PORT="not-a-number"', config: 'same layer (env)', default: '8123' },
  { PORT: 'not-a-number' },
  { port: 8123 },
  { port: invalidNumeric.server.port },
  'A non-numeric explicit value fails safe to the default instead of producing NaN (`Number.isFinite` guard).',
);

const invalidEnum = withEnv({ LOG_LEVEL: 'verbose' }, () => loadPanelConfig());
check(
  'A4',
  { explicit: 'LOG_LEVEL="verbose"', config: 'whitelist in loadPanelConfig', default: 'info' },
  { LOG_LEVEL: 'verbose' },
  { level: 'info' },
  { level: invalidEnum.log.level },
  'An out-of-enum explicit value is rejected and the whitelist default is used — the only enum-style setting in PanelConfig.',
);

const blankBoolean = withEnv({ KNOWLEDGE_LLM_BINDING_SYNC: '' }, () => loadPanelConfig());
const upperBoolean = withEnv({ KNOWLEDGE_LLM_BINDING_SYNC: 'TRUE' }, () => loadPanelConfig());
check(
  'A5',
  { explicit: 'KNOWLEDGE_LLM_BINDING_SYNC="" and "TRUE"', config: 'envBool()', default: 'true' },
  { blank: '', upper: 'TRUE' },
  { blank: true, upper: false },
  { blank: blankBoolean.knowledgeLlmBinding.sync, upper: upperBoolean.knowledgeLlmBinding.sync },
  'envBool(): blank explicit input falls back to the default `true`, while any non-"true"/"1" explicit value (even "TRUE") beats the default with false.',
);

const blankString = withEnv({ KNOWLEDGE_SERVICE_URL: '' }, () => loadPanelConfig());
check(
  'A6',
  { explicit: 'KNOWLEDGE_SERVICE_URL=""', config: 'env() string layer', default: 'http://127.0.0.1:8421' },
  { KNOWLEDGE_SERVICE_URL: '' },
  { baseUrl: '' },
  { baseUrl: blankString.knowledge.baseUrl },
  'Conflict case: for STRING settings `env()` uses `??`, so an explicit empty string DOES shadow the default (unlike envInt/envBool). The resulting empty baseUrl then forces the KS client to be explicitly reconfigured — the precedence rule is deliberately "explicit wins".',
);

const conflict = withEnv(
  {
    HOST: '10.9.9.9',
    PORT: '',
    METADATA_INSTANCES_CONFIG: './config/instances.alt.json',
    LOG_LEVEL: 'trace',
    KNOWLEDGE_SERVICE_URL: '',
    KNOWLEDGE_LLM_BINDING_SYNC: 'false',
  },
  () => loadPanelConfig(),
);
check(
  'A7',
  { explicit: 'conflicting mix (see input)', config: 'env layer', default: 'built-in fallbacks' },
  { HOST: '10.9.9.9', PORT: '', METADATA_INSTANCES_CONFIG: './config/instances.alt.json', LOG_LEVEL: 'trace', KNOWLEDGE_SERVICE_URL: '', KNOWLEDGE_LLM_BINDING_SYNC: 'false' },
  { host: '10.9.9.9', port: 8123, metadataInstancesConfig: './config/instances.alt.json', level: 'info', knowledgeBaseUrl: '', sync: false },
  {
    host: conflict.server.host,
    port: conflict.server.port,
    metadataInstancesConfig: conflict.metadataInstancesConfig,
    level: conflict.log.level,
    knowledgeBaseUrl: conflict.knowledge.baseUrl,
    sync: conflict.knowledgeLlmBinding.sync,
  },
  'Normalized end-to-end resolution: valid explicit input wins, blank/invalid explicit input degrades to the default per-field (except the empty-string case of A6).',
);

// ── B. instance routing: explicit request input > registry config > gateway default

const CONFIG_ENTRIES = [
  {
    instance_id: 'default',
    name: 'local-default',
    gateway_endpoint: 'http://127.0.0.1:8420',
    api_key: 'cfg-key-default',
  },
  {
    instance_id: 'proxy-split',
    name: 'core-proxy-split',
    gateway_endpoint: 'http://127.0.0.1:8420',
    proxy_endpoint: 'http://127.0.0.1:8096',
    api_key: 'cfg-key-proxy',
  },
];
const registry = new InstanceRegistry(CONFIG_ENTRIES);

const resolved = registry.resolve('proxy-split');
check(
  'B1',
  { explicit: 'request header x-tdai-service-id="proxy-split"', config: 'registry entry proxy-split', default: 'n/a (no default instance)' },
  { requestHeader: 'proxy-split' },
  { instance_id: 'proxy-split', gateway_endpoint: 'http://127.0.0.1:8420', proxy_endpoint: 'http://127.0.0.1:8096', api_key: 'cfg-key-proxy' },
  {
    instance_id: resolved.instance_id,
    gateway_endpoint: resolved.gateway_endpoint,
    proxy_endpoint: resolved.proxy_endpoint,
    api_key: resolved.api_key,
  },
  'The request header is a selector, not a value source: it is resolved against the registry config, which supplies gateway_endpoint/api_key for the forwarded call.',
);

let unknownError = null;
try {
  registry.resolve('does-not-exist');
} catch (err) {
  unknownError = err;
}
check(
  'B2',
  { explicit: 'request header x-tdai-service-id="does-not-exist"', config: 'no matching registry entry', default: 'NO silent fallback' },
  { requestHeader: 'does-not-exist' },
  { name: 'InstanceRegistryError', code: 400, message: 'INVALID_INSTANCE' },
  {
    name: unknownError?.constructor?.name,
    code: unknownError?.code,
    message: unknownError?.message,
  },
  'Conflict between explicit request input and config fails closed with 400 INVALID_INSTANCE; the panel never borrows a default instance when the explicit id is unknown.',
);

const publicList = registry.listPublic();
check(
  'B3',
  { explicit: 'n/a', config: 'entry default (no proxy_endpoint)', default: 'gateway_endpoint fallback (client-side)' },
  { publicKey: 'proxy_endpoint' },
  { present: false },
  { present: Object.prototype.hasOwnProperty.call(publicList[0], 'proxy_endpoint') },
  'When the config omits proxy_endpoint the key is not emitted at all (`...(proxy_endpoint ? {proxy_endpoint} : {})`), so the client `?? gateway_endpoint` fallback (the default) applies for the default instance.',
);

check(
  'B4',
  { explicit: 'n/a', config: 'entry proxy-split (proxy_endpoint set)', default: 'gateway_endpoint fallback (client-side)' },
  { publicKey: 'proxy_endpoint' },
  { value: 'http://127.0.0.1:8096' },
  { value: publicList[1].proxy_endpoint },
  'An explicit config value for proxy_endpoint beats the gateway_endpoint fallback and is the value the UI/CLI must consume.',
);

check(
  'B5',
  { explicit: 'n/a', config: 'registry entries', default: 'n/a' },
  { secrets: ['api_key'] },
  { leaked: [] },
  { leaked: Object.keys(publicList[0]).filter((k) => k === 'api_key') },
  'Precedence is also a disclosure boundary: listPublic() only exposes non-secret routing fields, so a client-side default can never resurrect the credential.',
);

// ── C. request-header layer, executed through the real middleware ────────────

function makeContext({ path: reqPath, headers }) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const state = {};
  return {
    req: { path: reqPath, header: (name) => lowered[String(name).toLowerCase()] },
    get: (k) => state[k],
    set: (k, v) => {
      state[k] = v;
    },
    json: (body, status) => ({ body, status }),
  };
}

const middleware = validatePanelMetaHeaders({ instanceRegistry: registry });

async function runMiddleware(ctx) {
  let nextCalled = false;
  const response = await middleware(ctx, async () => {
    nextCalled = true;
  });
  return { nextCalled, response: response ?? null, meta: ctx.get('panelMeta') };
}

const LIST_PATH = '/v3/meta/agent/list';
const VERIFY_PATH = '/v3/meta/auth/verify';

const explicitHeader = await runMiddleware(
  makeContext({ path: LIST_PATH, headers: { 'x-tdai-service-id': '  proxy-split  ', 'x-tdai-user-key': 'u-1' } }),
);
check(
  'C1',
  { explicit: 'header "  proxy-split  "', config: 'registry entry proxy-split', default: 'none' },
  { header: '  proxy-split  ' },
  {
    nextCalled: true,
    message: undefined,
    meta: {
      instanceId: 'proxy-split',
      gatewayEndpoint: 'http://127.0.0.1:8420',
      gatewayApiKey: 'cfg-key-proxy',
      userKey: 'u-1',
    },
  },
  {
    nextCalled: explicitHeader.nextCalled,
    message: explicitHeader.response?.body?.message,
    meta: explicitHeader.meta,
  },
  'The trimmed request header selects the instance; every downstream value (endpoint, credential) is taken from the config entry, so no default leaks in.',
);

const missingHeader = await runMiddleware(makeContext({ path: LIST_PATH, headers: { 'x-tdai-user-key': 'u-1' } }));
const blankHeader = await runMiddleware(makeContext({ path: LIST_PATH, headers: { 'x-tdai-service-id': '   ', 'x-tdai-user-key': 'u-1' } }));
check(
  'C2',
  { explicit: 'absent / blank header', config: 'registry entry default exists', default: 'no fallback to it' },
  { absent: 'no x-tdai-service-id', blank: '"   "' },
  { absent: { status: 400, message: 'MISSING_INSTANCE_ID', nextCalled: false }, blank: { status: 400, message: 'MISSING_INSTANCE_ID', nextCalled: false } },
  {
    absent: { status: missingHeader.response?.status, message: missingHeader.response?.body?.message, nextCalled: missingHeader.nextCalled },
    blank: { status: blankHeader.response?.status, message: blankHeader.response?.body?.message, nextCalled: blankHeader.nextCalled },
  },
  'A blank explicit header is trimmed to empty and rejected with MISSING_INSTANCE_ID — it never silently resolves to the configured "default" instance.',
);

const unknownHeader = await runMiddleware(
  makeContext({ path: LIST_PATH, headers: { 'x-tdai-service-id': 'does-not-exist', 'x-tdai-user-key': 'u-1' } }),
);
check(
  'C3',
  { explicit: 'header "does-not-exist"', config: 'no matching entry (a "default" entry does exist)', default: 'must NOT be used' },
  { header: 'does-not-exist' },
  { status: 400, message: 'INVALID_INSTANCE', nextCalled: false },
  { status: unknownHeader.response?.status, message: unknownHeader.response?.body?.message, nextCalled: unknownHeader.nextCalled },
  'Explicit input that conflicts with config fails closed with INVALID_INSTANCE; the configured default instance is not borrowed.',
);

const missingUserKey = await runMiddleware(makeContext({ path: LIST_PATH, headers: { 'x-tdai-service-id': 'default' } }));
const verifyWithoutUserKey = await runMiddleware(makeContext({ path: VERIFY_PATH, headers: { 'x-tdai-service-id': 'default' } }));
check(
  'C4',
  { explicit: 'configured id without x-tdai-user-key', config: 'n/a', default: 'n/a' },
  { action: 'agent/list' },
  { status: 400, message: 'MISSING_USER_KEY', nextCalled: false },
  { status: missingUserKey.response?.status, message: missingUserKey.response?.body?.message, nextCalled: missingUserKey.nextCalled },
  'After instance precedence is settled, the user-key requirement still applies to business routes.',
);

check(
  'C5',
  { explicit: 'configured id, no user key, action auth/verify', config: 'AUTH_VERIFY exception', default: 'n/a' },
  { action: 'auth/verify' },
  { nextCalled: true, instanceId: 'default', userKey: undefined },
  { nextCalled: verifyWithoutUserKey.nextCalled, instanceId: verifyWithoutUserKey.meta?.instanceId, userKey: verifyWithoutUserKey.meta?.userKey },
  'The auth/verify exception only relaxes the user-key rule; it does not change which layer supplies the instance.',
);

// ── D. citation integrity for the evidence contract ─────────────────────────

const REQUIRED_CITATIONS = [
  { path: 'MemoryPanel/src/panel/config/panel-config.ts', symbol: 'loadPanelConfig', start_line: 43, end_line: 69 },
  { path: 'MemoryPanel/src/panel/config/panel-config.ts', symbol: 'env', start_line: 6, end_line: 8 },
  { path: 'MemoryPanel/src/panel/config/panel-config.ts', symbol: 'envInt', start_line: 10, end_line: 15 },
  { path: 'MemoryPanel/src/panel/config/panel-config.ts', symbol: 'envBool', start_line: 37, end_line: 41 },
  { path: 'MemoryPanel/src/panel/config/instance-registry.ts', symbol: 'resolve', start_line: 96, end_line: 102 },
  { path: 'MemoryPanel/src/panel/config/instance-registry.ts', symbol: 'listPublic', start_line: 104, end_line: 112 },
];

for (const c of REQUIRED_CITATIONS) {
  const lines = readFileSync(path.join(REPO, c.path), 'utf8').split('\n');
  const slice = lines.slice(c.start_line - 1, c.end_line).join('\n');
  check(
    `D:${c.symbol}`,
    { explicit: 'n/a', config: 'n/a', default: 'n/a' },
    { path: c.path, symbol: c.symbol, range: [c.start_line, c.end_line] },
    { containsSymbol: true },
    { containsSymbol: slice.includes(c.symbol) },
    `Citation integrity: ${c.path}:${c.start_line}-${c.end_line} really contains \`${c.symbol}\`.`,
  );
}

// ── normalized operation result ─────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
const result = {
  schema: 'memorypanel.precedence-demo/v1',
  task_id: 'T05',
  repository: 'tdam',
  mode: 'contract',
  subject: 'MemoryPanel instance/panel configuration precedence',
  precedence_order: [
    '1. explicit request input (per-request env override / x-tdai-service-id header) — highest',
    '2. config (env values at load time; instance registry JSON entries)',
    '3. built-in default (env()/envInt()/envBool() fallbacks; client-side gateway_endpoint fallback) — lowest',
  ],
  sources_under_test: [
    'MemoryPanel/src/panel/config/panel-config.ts',
    'MemoryPanel/src/panel/config/instance-registry.ts',
    'MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts',
  ],
  shims_applied: [...appliedShims].sort(),
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  normalized_panel_config: conflict,
  normalized_instance_resolution: {
    request_header: 'proxy-split',
    resolved_instance_id: resolved.instance_id,
    gateway_endpoint: resolved.gateway_endpoint,
    proxy_endpoint: resolved.proxy_endpoint ?? resolved.gateway_endpoint,
    secret_exposed: false,
  },
  status: failed.length === 0 ? 'pass' : 'fail',
};

const outPath = path.join(HERE, 'precedence-demo-output.json');
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(10)} ${JSON.stringify(c.input)}`);
}
console.log(`\n${result.summary.passed}/${result.summary.total} precedence checks passed`);
console.log(`normalized result written to ${path.relative(REPO, outPath)}`);
process.exit(failed.length === 0 ? 0 : 1);
