/** Public advanced test support. Contains no correctness assertions or repair.
 * Target modules import one another's real submitted implementations. Only
 * non-corpus dependencies and external boundaries are substituted. Node 24.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuiltin, stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const coding = 'packages/coding-agent/src/';
const agent = 'packages/agent/src/harness/';
export const modules = {
  resource: coding + 'core/resource-loader.ts', settings: coding + 'core/settings-manager.ts',
  project: coding + 'core/project-trust.ts', migration: coding + 'migrations.ts',
  session: coding + 'core/session-manager.ts', text: coding + 'utils/text.ts', paths: coding + 'utils/paths.ts',
  drive: agent + 'runtime/drive/tools.ts', execution: agent + 'execution/tools.ts',
  gate: agent + 'execution/effect-gate.ts', placement: agent + 'runtime/drive/tool-placement.ts',
};
const entrypoints = new Set(Object.values(modules));

/** Each graph has its own module cache and boundary state; no source is rewritten.
 * `trailer` only exposes the private recovery entry and injects checkpoint/store
 * boundary functions. Actual execution, gate, finalization and placement run live.
 */
export function createGraph(root, bindings = {}, builtinOverrides = {}) {
  root = path.resolve(root);
  const context = createContext({ console, Date, Map, Set, Promise, Error, TypeError,
    Buffer, AbortController, AbortSignal, structuredClone,
    process: { platform: process.platform, cwd: () => root, env: {} },
  });
  const cache = new Map();
  const requests = new Map();
  function get(relative) {
    if (cache.has(relative)) return cache.get(relative);
    let source = stripTypeScriptTypes(fs.readFileSync(path.join(root, relative), 'utf8'), { mode: 'strip' });
    if (relative === modules.drive) source += `
export function __recoveryBoundaries(hooks) {
  clearReplayCheckpoint = hooks.clear;
  readCheckpoint = hooks.read;
  publishToolOutcome = hooks.publish;
  return recoverToolInvocation;
}
`;
    const mod = new SourceTextModule(source, { context, identifier: relative });
    cache.set(relative, mod);
    const dependencies = new Map();
    for (const [, clause, specifier] of source.matchAll(/\bimport\s+([^;]+?)\s+from\s+["']([^"']+)["'];/g)) {
      const names = new Set(dependencies.get(specifier) ?? []);
      if (!clause.trim().startsWith('{')) names.add('default');
      const group = clause.match(/\{([^}]+)\}/);
      if (group) for (const field of group[1].split(',')) {
        const name = field.trim().split(/\s+/)[0];
        if (name) names.add(name);
      }
      dependencies.set(specifier, names);
    }
    requests.set(relative, dependencies);
    return mod;
  }
  async function link(specifier, parent) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier), specifier));
    if (specifier.startsWith('.') && entrypoints.has(resolved)) return get(resolved);
    const builtin = isBuiltin(specifier) ? await import(specifier) : null;
    const names = builtin ? Object.keys(builtin) : [...(requests.get(parent.identifier)?.get(specifier) ?? [])];
    return new SyntheticModule(names, function () {
      for (const name of names) {
        const overrides = builtinOverrides[parent.identifier] ?? {};
        const value = builtin ? (Object.hasOwn(overrides, name) ? overrides[name]
          : name === 'default' && typeof builtin.default === 'object' && Object.keys(overrides).length
            ? { ...builtin.default, ...overrides } : builtin[name]) : bindings[name];
        this.setExport(name, value ?? function () { throw new Error(`Unexpected boundary: ${specifier}:${name}`); });
      }
    }, { context });
  }
  return {
    async module(name) {
      const mod = get(modules[name] ?? name);
      if (mod.status === 'unlinked') await mod.link(link);
      if (mod.status === 'linked') await mod.evaluate({ timeout: 3000 });
      return mod.namespace;
    },
  };
}

/** Coupled real resolver -> loader -> SettingsManager -> resource selection.
 * Storage is in-memory but SettingsManager's parsing, trust and merge code is real.
 * Mutate scenario to change extension/store/UI decisions between reloads.
 */
export async function createResourcePipeline(root) {
  const events = [];
  const scenario = { override: undefined, stored: null, extension: undefined, hasUI: false, policy: 'ask' };
  const consentWrites = [];
  const global = { defaultModel: 'global-model', extensions: ['global'], compaction: { reserveTokens: 8192, keepRecentTokens: 2000 } };
  const project = { defaultModel: 'project-model', extensions: ['project'], compaction: { reserveTokens: 4096 } };
  const storageData = { global: JSON.stringify(global), project: JSON.stringify(project) };
  const storage = { withLock(scope, fn) { events.push(['storage', scope]); const next = fn(storageData[scope]);
    if (next !== undefined) storageData[scope] = next; } };
  const resourcePath = (name) => path.join(root, '.fixture-resources', `${name}.ts`);
  const resources = (names) => ({ extensions: names.map((name) => ({ path: resourcePath(name), enabled: true,
    metadata: { source: 'local', scope: name === 'project' ? 'project' : 'user', origin: 'top-level' } })),
    skills: [], prompts: [], themes: [] });
  let settings;
  const graph = createGraph(root, {
    APP_NAME: 'pi', CONFIG_DIR_NAME: '.pi', DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60000,
    DEFAULT_HTTP_IDLE_TIMEOUT_MS: 60000, parseHttpIdleTimeoutMs: (value) => value,
    hasTrustRequiringProjectResources: () => true,
    emitProjectTrustEvent: async () => { events.push(['extension-decision']); return { result: scenario.extension, errors: [] }; },
    getProjectTrustOptions: () => [{ label: 'approve once', trusted: true, updates: [] }],
    createEventBus: () => ({}), createExtensionRuntime: () => ({}), resetTimings: () => {}, clearExtensionCache: () => {},
    createSourceInfo: (filename, metadata) => ({ path: filename, ...metadata }),
    DefaultPackageManager: class {
      async resolve() {
        events.push(['resolve', settings.isProjectTrusted(), settings.getDefaultModel()]);
        return resources([...(settings.getGlobalSettings().extensions ?? []), ...(settings.getProjectSettings().extensions ?? [])]);
      }
      async resolveExtensionSources() { return resources(['cli']); }
    },
    async loadExtensionsCached(filenames, _cwd, _bus, runtime = {}) {
      events.push(['load', filenames.map((filename) => path.basename(filename))]);
      return { extensions: filenames.map((filename) => ({ path: filename, resolvedPath: filename,
        commands: new Map(), tools: new Map(), flags: new Map() })), errors: [], runtime };
    },
  });
  const { SettingsManager } = await graph.module('settings');
  settings = SettingsManager.fromStorage(storage, { projectTrusted: true });
  const { DefaultResourceLoader } = await graph.module('resource');
  const { resolveProjectTrusted } = await graph.module('project');
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(root, '.fixture-agent'), settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: '', appendSystemPrompt: [] });
  const resolve = (extensionsResult) => resolveProjectTrusted({ cwd: root,
    trustOverride: scenario.override, defaultProjectTrust: scenario.policy, extensionsResult,
    trustStore: { get: () => scenario.stored,
      set: (...args) => consentWrites.push(args), setMany: (...args) => consentWrites.push(args) },
    projectTrustContext: { hasUI: scenario.hasUI, ui: { select: async () => 'approve once' } },
  });
  return { graph, loader, settings, scenario, events, consentWrites, storageData, resolve,
    async reload() {
      let calls = 0;
      await loader.reload({ resolveProjectTrust: async ({ extensionsResult }) => { calls++; return resolve(extensionsResult); } });
      return { calls, names: loader.getExtensions().extensions.map((e) => path.basename(e.path)) };
    },
  };
}

/** Real migration -> real text/path helpers -> real session reader. */
export async function createSessionPipeline(root, agentDir) {
  const graph = createGraph(root, { getAgentDir: () => agentDir }, {
    [modules.migration]: { readdirSync: (...args) => fs.readdirSync(...args).sort((a, b) => {
      const left = typeof a === 'string' ? a : a.name;
      const right = typeof b === 'string' ? b : b.name;
      return left < right ? -1 : left > right ? 1 : 0;
    }) },
  });
  return { graph, migration: await graph.module('migration'), session: await graph.module('session'), text: await graph.module('text') };
}

/** Real recovery -> real tool executor/finalizer -> real effect gate.
 * Checkpoint storage, progress transport and hook delivery are observable fakes.
 * options supports persisted, declared (undefined = missing), cancelled, arguments,
 * effect({update, context, invocation}), patch, gateState and gateError.
 */
export async function createExecutionPipeline(root) {
  const graphFor = (progress) => createGraph(root, {
    withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
    validateToolArguments: (_tool, call) => {
      if (typeof call.arguments?.message !== 'string') throw new Error('message must be a string');
      return call.arguments;
    },
    SessionInvariantError: class extends Error {},
    openToolProgress: () => progress,
  });
  const graph = graphFor(undefined);
  const gateModule = await graph.module('gate');
  const execution = await graph.module('execution');
  async function run(options = {}) {
    const events = [];
    const updates = [];
    const checkpoints = [];
    let outcome;
    let callback;
    let capturedContext;
    const progress = { write(partial) { events.push('checkpoint'); checkpoints.push(partial); },
      seal() { events.push('seal'); }, async drain() {
        events.push('drain');
        if (options.progressDrain) await options.progressDrain();
        events.push('drain-complete');
      } };
    // Each concurrent invocation has its own module globals and IO bindings.
    const runGraph = graphFor(progress);
    const driveModule = await runGraph.module('drive');
    const runGate = await runGraph.module('gate');
    const { gate, control } = runGate.createGate();
    if (options.gateState === 'aborting') control.beginAbort(Promise.resolve());
    if (options.gateState === 'closed') control.close(options.gateError ?? new Error('closed gate'));
    const toolCall = { id: 'call-2', name: 'fixture-tool', arguments: { message: 'raw-model-arguments' } };
    const call = { sourceIndex: 2, resultEntryId: 'result-2', status: 'effect_pending', replay: Object.hasOwn(options, 'persisted') ? options.persisted : 'safe' };
    const batch = { turnId: 'turn-1', calls: [call] };
    const declaration = Object.hasOwn(options, 'declared') ? options.declared : 'safe';
    const tool = declaration === undefined ? undefined : { name: toolCall.name, replay: declaration,
      async execute(_id, args, update, _toolContext, invocation, context) {
        events.push('invoke'); callback = update; capturedContext = context;
        const result = options.effect ? await options.effect({ args, update, context, invocation, control })
          : { content: [{ type: 'text', text: args.message }], details: { kept: true }, usage: { output: 3 } };
        events.push('effect-complete'); return result;
      },
    };
    const lane = { name: 'main', state: { operation: { state: { at: 'tools', batch } } },
      async emitBatch(items) { events.push('update'); updates.push(...items); },
      hooks: { async runToolWithGate(_stage, _input, admission) {
        return admission.admit(() => options.patch);
      } },
    };
    const drive = { operationId: 'op-1', gate, context: {} };
    const recover = driveModule.__recoveryBoundaries({
      async clear() { events.push('clear'); return options.arguments ?? { message: 'persisted-arguments' }; },
      async read() { events.push('read'); return { content: [{ type: 'text', text: 'checkpoint-evidence' }], details: { step: 2 } }; },
      async publish(_lane, _drive, _run, _call, value) {
        events.push('publish'); outcome = value;
        if (options.onPublish) options.onPublish(value);
      },
    });
    const task = await recover(lane, drive, { batch }, { calls: new Map([[2, toolCall]]) }, call,
      new Map(tool ? [[toolCall.name, tool]] : []), {}, options.cancelled ?? false);
    await task.completion;
    return { events, updates, checkpoints, outcome, callback, context: capturedContext, control, gate };
  }
  return { graph, gate: gateModule, execution, run };
}
