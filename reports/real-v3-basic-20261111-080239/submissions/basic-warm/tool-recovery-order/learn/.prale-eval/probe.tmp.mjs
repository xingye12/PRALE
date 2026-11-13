import * as path from 'node:path';
import { createGraph } from './subject.mjs';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const B = 'packages/agent/src/harness/';
const modules = [
  `${B}runtime/drive/tools.ts`,
  `${B}runtime/drive/tool-placement.ts`,
  `${B}runtime/progress.ts`,
  `${B}execution/tools.ts`,
  `${B}execution/effect-gate.ts`,
  `${B}session/values.ts`,
  `${B}session/commit.ts`,
  `${B}session/session.ts`,
  `${B}session/mutation-line.ts`,
  `${B}context.ts`,
];
const bindings = {
  validateToolArguments: (tool, call) => call.arguments,
  uuidv7: () => 'uuid',
  awaitWithContext: (p) => p,
  withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
  withCancel: () => ({}),
  withContextValue: () => ({}),
  withoutAbortSignal: (context) => context,
  createContextKey: (name) => ({ name }),
  BACKGROUND_CONTEXT: {},
  NOOP_TELEMETRY_CONTEXT: {},
};
const graph = createGraph(root, modules, bindings);
const tools = await graph.module(`${B}runtime/drive/tools.ts`);
console.log('loaded ok', Object.keys(tools));
