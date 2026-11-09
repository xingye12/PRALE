// Regression for extension-trust/correction.
//
// Exercises the real DefaultResourceLoader.reload() lifecycle through the
// caller-owned boundary fakes provided by subject.mjs and asserts that:
//   1. the trust resolver is consulted exactly once,
//   2. it observes the untrusted bootstrap extension result,
//   3. the decision is applied only after the resolver settles,
//   4. project resources load after `true` and stay denied after `false`.
//
// Run from the workspace root:
//   node --experimental-vm-modules .prale-eval/regression.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { createTrustSubject } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");
// Copy into host-realm arrays: the subject module's arrays come from another VM realm,
// so comparing them directly with deepStrictEqual would only ever report prototype mismatches.
const names = (extensionsResult) => Array.from(extensionsResult.extensions, (extension) => path.basename(extension.path));
const isEvent = (event, kind, value) => event[0] === kind && event[1] === value;

// --- Scenario 1: a true decision must admit project resources. ---
{
  const { loader, events, state } = await createTrustSubject(root);
  const calls = [];

  await loader.reload({
    resolveProjectTrust: async ({ extensionsResult }) => {
      const call = {
        extensions: names(extensionsResult),
        settingsTrusted: state.trusted,
        settingsLoadedTrust: state.loadedTrust,
        eventsAtCall: events.slice(),
      };
      calls.push(call);
      await new Promise((resolve) => setTimeout(resolve, 10));
      call.eventsAtReturn = events.slice();
      return true;
    },
  });

  assert.equal(
    calls.length,
    1,
    "reload() with a resolveProjectTrust callback must consult the trust resolver exactly once",
  );

  assert.deepEqual(
    calls[0].extensions,
    ["cli.ts", "user.ts"],
    "the resolver must observe the untrusted bootstrap result (CLI and user extensions only, project extension excluded)",
  );
  assert.ok(
    calls[0].eventsAtCall.some(
      (event) =>
        event[0] === "extensions" &&
        Array.isArray(event[1]) &&
        event[1].includes("user.ts") &&
        !event[1].includes("project.ts"),
    ),
    "the untrusted bootstrap extension load must complete before the resolver is consulted",
  );
  assert.equal(calls[0].settingsTrusted, false, "project settings must be untrusted while the resolver is consulted");
  assert.equal(
    calls[0].settingsLoadedTrust,
    false,
    "the bootstrap settings reload must have completed as untrusted before the resolver is consulted",
  );
  assert.equal(
    calls[0].eventsAtReturn.some(
      (event) => isEvent(event, "set", true) || isEvent(event, "resolve", true) || isEvent(event, "settings", true),
    ),
    false,
    "the trust decision must not be applied or consumed before the asynchronous resolver settles",
  );

  assert.deepEqual(
    names(loader.getExtensions()),
    ["cli.ts", "user.ts", "project.ts"],
    "project resources must load after a true trust decision (loaded user extensions are reused, not skipped)",
  );
  assert.equal(state.loadedTrust, true, "settings must be reloaded as trusted after a true decision");

  const setTrue = events.findIndex((event) => isEvent(event, "set", true));
  assert.ok(setTrue >= 0, "a true decision must be written to settings");
  const settingsTrue = events.findIndex((event, index) => index > setTrue && isEvent(event, "settings", true));
  assert.ok(settingsTrue > setTrue, "settings must be reloaded for the true decision after it is written");
  const resolveTrusted = events.findIndex(
    (event, index) => index > settingsTrue && isEvent(event, "resolve", true),
  );
  assert.ok(resolveTrusted > settingsTrue, "project resources must be resolved only after trusted settings load");
}

// --- Scenario 2: a false decision must keep project resources denied. ---
{
  const { loader, events, state } = await createTrustSubject(root);
  const calls = [];

  await loader.reload({
    resolveProjectTrust: async ({ extensionsResult }) => {
      calls.push({
        extensions: names(extensionsResult),
        settingsTrusted: state.trusted,
        settingsLoadedTrust: state.loadedTrust,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return false;
    },
  });

  assert.equal(calls.length, 1, "the resolver must be consulted exactly once when it denies trust");
  assert.deepEqual(
    calls[0].extensions,
    ["cli.ts", "user.ts"],
    "a denying resolver must also observe the untrusted bootstrap result",
  );
  assert.equal(calls[0].settingsTrusted, false, "settings must be untrusted while the resolver is consulted");
  assert.equal(calls[0].settingsLoadedTrust, false, "bootstrap settings must be loaded as untrusted");
  assert.equal(
    events.some((event) => isEvent(event, "set", true) || isEvent(event, "resolve", true)),
    false,
    "a false decision must never enable project trust",
  );
  assert.deepEqual(
    names(loader.getExtensions()),
    ["cli.ts", "user.ts"],
    "project resources must remain denied after a false trust decision",
  );
  assert.equal(state.loadedTrust, false, "settings must be reloaded as untrusted after a false decision");
}

// --- Scenario 3: without a resolver, the caller-provided trust state is preserved. ---
{
  const { loader, state } = await createTrustSubject(root);
  await loader.reload();

  assert.deepEqual(
    names(loader.getExtensions()),
    ["cli.ts", "user.ts", "project.ts"],
    "reload() without a trust resolver must keep the caller-provided trusted state",
  );
  assert.equal(state.loadedTrust, true, "caller-provided trust must not be forced to untrusted");
}

console.log("regression: trust resolver consulted once, ordered, and honored");
