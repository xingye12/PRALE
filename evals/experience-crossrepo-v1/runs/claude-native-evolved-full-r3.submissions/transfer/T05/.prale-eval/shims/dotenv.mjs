// Offline shim for the `dotenv` runtime dependency.
//
// The real MemoryPanel package depends on `dotenv` (see MemoryPanel/package.json).
// Dependencies are NOT installed in this evaluation workspace and the task
// forbids installing them, so this shim lets the precedence demo import the
// real `panel-config.ts` module in a dependency-free way.
//
// `loadPanelConfig()` calls `loadDotenv()` (i.e. dotenv `config()`) at module
// load purely to populate `process.env` from a `.env` file. The demo sets
// process.env explicitly, so the shim intentionally does nothing.
export function config() {
  return { parsed: {} };
}

export default { config };
