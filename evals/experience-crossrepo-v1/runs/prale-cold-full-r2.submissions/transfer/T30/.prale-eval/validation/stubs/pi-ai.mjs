// Minimal stand-in for `@earendil-works/pi-ai`. settings-manager.ts imports the retry delay
// constant from it; the type-only imports are erased by Node's type stripping.
export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60000;
