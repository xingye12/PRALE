/**
 * panel-config precedence test — executable, dependency-free.
 *
 * WHAT IT DOES
 *   Executes the REAL source file
 *       MemoryPanel/src/panel/config/panel-config.ts
 *   (imported live via Node's TypeScript type-stripping) under scenarios where the
 *   three configuration sources conflict, and asserts the resolved values:
 *
 *       1. explicit input   — a value provided explicitly at process launch
 *                             (already present in process.env), the most specific source
 *       2. config           — the deployment `.env` file loaded by dotenv `config()`
 *       3. default          — the built-in fallback literal in loadPanelConfig()
 *
 *   Only `dotenv` is redirected to a faithful local stub (dotenv's `override:false`
 *   rule). No dependency is installed. The panel-config.ts source file is NOT modified.
 *
 * RUN
 *   node --import ./.prale-eval/harness/register.mjs ./.prale-eval/harness/precedence-runner.mjs
 *
 * Exit code 0 = every precedence assertion held.
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const TARGET_TS = resolve(REPO_ROOT, 'MemoryPanel/src/panel/config/panel-config.ts');
const TMP_ROOT = resolve(HERE, 'tmp');

const PANEL_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** Read a dotted path out of the resolved PanelConfig object. */
function pick(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function scenarioDir(id) {
  return resolve(TMP_ROOT, id);
}

function writeEnvFile(id, envFile) {
  const dir = scenarioDir(id);
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(envFile)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(resolve(dir, '.env'), body.length ? body + '\n' : '', 'utf8');
  return dir;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Scenarios. Each supplies:
 *   explicit — process input / explicit request-level value (highest priority)
 *   envFile  — the .env "config" layer
 *   expect   — expected resolved key/value pairs after loadPanelConfig()
 * ──────────────────────────────────────────────────────────────────────────── */
const DEFAULTS = {
  'server.host': '0.0.0.0',
  'server.port': 8123,
  metadataInstancesConfig: './config/metadata-instances.json',
  metadataRemoteTimeoutMs: 15000,
  'ui.distDir': './web/dist',
  'log.level': 'info',
  'log.format': 'json',
  'knowledge.baseUrl': 'http://127.0.0.1:8421',
  'knowledge.authToken': '',
  'knowledge.timeoutMs': 15000,
  'knowledgeLlmBinding.sync': true,
  'knowledgeLlmBinding.proxyBaseUrl': 'http://127.0.0.1:8096',
  agentTemplateDir: './data/agent-templates',
};

const scenarios = [
  {
    id: 'A_all-three-conflict__explicit-wins',
    title: 'All three sources conflict → explicit input beats config beats default',
    explicit: { PORT: '9999', KNOWLEDGE_SERVICE_URL: 'http://explicit-ks:2222' },
    envFile: {
      PORT: '8000',
      KNOWLEDGE_SERVICE_URL: 'http://config-ks:1111',
      TDAI_AGENT_TEMPLATE_DIR: '/from-env-file',
    },
    expect: {
      'server.port': 9999, // explicit > config(8000) > default(8123)
      'knowledge.baseUrl': 'http://explicit-ks:2222', // explicit > config > default
      agentTemplateDir: '/from-env-file', // config > default
    },
  },
  {
    id: 'B_no-explicit__config-wins',
    title: 'No explicit input → config (.env) beats the built-in default',
    explicit: {},
    envFile: { PORT: '8000', KNOWLEDGE_TIMEOUT_MS: '2500', KNOWLEDGE_LLM_BINDING_SYNC: 'false' },
    expect: {
      'server.port': 8000, // config > default 8123
      'knowledge.timeoutMs': 2500, // config > default 15000
      'knowledgeLlmBinding.sync': false, // config 'false' > default true
      'server.host': DEFAULTS['server.host'], // untouched → default
      'log.level': DEFAULTS['log.level'],
    },
  },
  {
    id: 'C_no-overrides__defaults',
    title: 'No explicit input, empty .env → every key resolves to its default',
    explicit: {},
    envFile: {},
    expect: { ...DEFAULTS },
  },
  {
    id: 'D_explicit-illegal-number__default-wins-over-config',
    title: 'Explicit non-numeric PORT is not finite → built-in default wins over config',
    explicit: { PORT: 'not-a-port', KNOWLEDGE_TIMEOUT_MS: '12abc' },
    envFile: { PORT: '8000', KNOWLEDGE_TIMEOUT_MS: '2500' },
    expect: {
      'server.port': 8123, // envInt: NaN → fallback default (config 8000 bypassed too)
      'knowledge.timeoutMs': 15000, // envInt: NaN → fallback default (config 2500 bypassed)
    },
  },
  {
    id: 'E_explicit-empty-number__default-wins',
    title: 'Explicit empty string for a numeric key → envInt returns the default',
    explicit: { PORT: '', KNOWLEDGE_TIMEOUT_MS: '' },
    envFile: { PORT: '8000' },
    expect: {
      'server.port': 8123, // '' short-circuits envInt to fallback
      'knowledge.timeoutMs': 15000,
    },
  },
  {
    id: 'F_explicit-enum__normalized-vs-default',
    title: 'Explicit enum values: valid honored, invalid normalized to default',
    explicit: { LOG_LEVEL: 'verbose', LOG_FORMAT: 'pretty' },
    envFile: { LOG_LEVEL: 'warn' },
    expect: {
      'log.level': 'info', // explicit invalid -> default 'info' (not the .env 'warn')
      'log.format': 'pretty', // explicit valid honored
    },
  },
  {
    id: 'G_explicit-empty-string__honored-for-string-keys',
    title: 'String keys use nullish coalescing: explicit "" wins over the default',
    explicit: { UI_DIST_DIR: '' },
    envFile: { UI_DIST_DIR: '/from-env-file' },
    expect: {
      'ui.distDir': '', // '' ?? default → '' (explicit empty is a real value)
    },
  },
  {
    id: 'H_envBool-canonical-only',
    title: 'envBool: explicit canonical wins; non-canonical collapses to false, else default',
    explicit: { KNOWLEDGE_LLM_BINDING_SYNC: '1' },
    envFile: {},
    expect: { 'knowledgeLlmBinding.sync': true },
  },
  {
    id: 'H2_envBool-explicit-false__false',
    title: 'envBool explicit "false" → false (explicit beats default true)',
    explicit: { KNOWLEDGE_LLM_BINDING_SYNC: 'false' },
    envFile: {},
    expect: { 'knowledgeLlmBinding.sync': false },
  },
  {
    id: 'H3_envBool-noncanonical__false-not-fallback',
    title: 'envBool non-canonical non-empty ("yes") → false, NOT the fallback default',
    explicit: { KNOWLEDGE_LLM_BINDING_SYNC: 'yes' },
    envFile: {},
    expect: { 'knowledgeLlmBinding.sync': false },
  },
  {
    id: 'I_instance-config-path__explicit-wins',
    title: 'Instance registry path (metadataInstancesConfig) obeys the same precedence',
    explicit: { METADATA_INSTANCES_CONFIG: '/explicit/instances.json' },
    envFile: { METADATA_INSTANCES_CONFIG: '/config/instances.json' },
    expect: { metadataInstancesConfig: '/explicit/instances.json' },
  },
  {
    id: 'I2_instance-config-path__config-wins',
    title: 'Instance registry path: config (.env) beats the built-in default',
    explicit: {},
    envFile: { METADATA_INSTANCES_CONFIG: '/config/instances.json' },
    expect: { metadataInstancesConfig: '/config/instances.json' },
  },
];

/* ────────────────────────────────────────── runner ───────────────────────── */

const snap = { ...process.env };
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in snap)) delete process.env[k];
  for (const [k, v] of Object.entries(snap)) process.env[k] = v;
}

const targetSrc = readFileSync(TARGET_TS, 'utf8');
const targetHash = createHash('sha256').update(targetSrc).digest('hex').slice(0, 16);

console.log('panel-config precedence test');
console.log('target :', TARGET_TS);
console.log('sha256 :', targetHash);
console.log('');

let passed = 0;
let failed = 0;
const results = [];

for (const sc of scenarios) {
  // 1. Start from a clean env (no leakage between scenarios).
  restoreEnv();
  // The harness may run with a stale .env of its own; neutralise by clearing keys
  // that scenarios control. Then apply the explicit "input" layer.
  const touched = new Set([
    ...Object.keys(DEFAULTS).map((k) => k),
    ...Object.keys(sc.envFile),
    ...Object.keys(sc.explicit),
    'PORT',
    'LOG_LEVEL',
    'LOG_FORMAT',
    'UI_DIST_DIR',
    'HOST',
  ]);
  for (const k of touched) delete process.env[k];
  for (const [k, v] of Object.entries(sc.explicit)) process.env[k] = v;

  // 2. Materialise the "config" (.env) layer and load the real module from there.
  const dir = writeEnvFile(sc.id, sc.envFile);
  const prevCwd = process.cwd();
  process.chdir(dir);
  let cfg;
  try {
    const url = pathToFileURL(TARGET_TS).href + `?scenario=${encodeURIComponent(sc.id)}`;
    const mod = await import(url);
    cfg = mod.loadPanelConfig();
  } finally {
    process.chdir(prevCwd);
  }

  // 3. Assert.
  const checks = [];
  for (const [dotted, want] of Object.entries(sc.expect)) {
    const got = pick(cfg, dotted);
    const ok = Object.is(got, want);
    checks.push({ key: dotted, want, got, ok });
  }
  const allOk = checks.every((c) => c.ok);
  if (allOk) passed += 1;
  else failed += 1;
  results.push({ id: sc.id, title: sc.title, ok: allOk, checks });

  console.log(`${allOk ? 'PASS' : 'FAIL'}  ${sc.id}`);
  console.log(`      ${sc.title}`);
  for (const c of checks) {
    console.log(
      `      ${c.ok ? '·' : 'X'} ${c.key}: expected ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}`,
    );
  }
  console.log('');
}

restoreEnv();
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  /* ignore */
}

const summary = { target: TARGET_TS, sha256: targetHash, passed, failed, total: passed + failed };
console.log('SUMMARY', JSON.stringify(summary));
process.exit(failed === 0 ? 0 : 1);
