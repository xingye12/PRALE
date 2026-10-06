# Contract demo — `server/core/config-queue.js`

Task: `learn/18` · repository `wattclaw` · mode `contract`
Request: *cover ordered updates and one rejected configuration action.*

## 1. Contract under test

`server/core/config-queue.js` exports `configQueueExecute(transformFn, label, method = 'config.patch')`,
which is the single funnel for gateway config modifications (used by `server/handlers/channels.js`,
`system.js` and `agent-team.js`).

| # | Contract clause | Source | Behaviour |
|---|-----------------|--------|-----------|
| C1 | **Ordered updates** | `ConfigQueue.enqueue` L15–20, `ConfigQueue._process` L24–37 | `enqueue()` appends `{transformFn, label, method, resolve, reject}` to `this._queue` and calls `_process()`. A `_running` flag makes the first caller the only drainer; the `while` loop shifts one item and fully `await`s `_execute(item)` before the next shift. Jobs therefore run strictly FIFO and job *N+1*'s `config.get` observes the config committed by job *N*. |
| C2 | **One rejected configuration action** | `ConfigQueue._execute` L60–99 | `_execute` runs `config.get` → `transformFn(sourceConfig)` → `config.patch{raw, baseHash}` → `config.get` → `config.apply`. A thrown error (or failed RPC) is caught at L84–97; only `config changed since last load` (optimistic concurrency) and `rate limit` errors are retried (max 2 retries, L87–93), everything else is returned as `{ok: false, error}`. `_process` then rejects **only that item's** promise and keeps draining, so the failure does not stall the queue and later jobs see the un-mutated config. |
| C3 | **No mutation on rejection** | `_execute` L60–83 | The failure path is reached before the `config.patch` call at L72, so a rejected action leaves the gateway hash, revision and applied config untouched. A transform returning a falsy value short-circuits at L69 as `{ok: true, data: null}` (resolved `null`, not a rejection). |

## 2. Executable demo

`node .prale-eval/config-queue-contract.mjs` (exit code 0 = contract holds).

The demo imports the **real** `server/core/config-queue.js`; a `node:module` `registerHooks` resolve
hook redirects only its `./gateway-client.js` import to `.prale-eval/stub-gateway-client.mjs`, an
in-memory fake of the admin-RPC surface (`config.get`, `config.patch`, `config.apply`) driven by
`globalThis.__configQueueRpcHandler`. No network, database, env file or npm install is involved, and
no repository source file is modified.

Coverage:

1. **`ordered-updates`** — two `configQueueExecute()` calls are issued back-to-back *without* awaiting,
   so only the queue itself can serialize them. Assertions:
   * observed transform order is `['A', 'B']` (FIFO);
   * job B's transform sees `channels.alpha` written by job A and has not yet seen its own write;
   * the recorded RPC sequence is exactly
     `config.get, config.patch, config.get, config.apply, config.get, config.patch, config.get, config.apply`
     — proving job B's `config.get` happens only after job A's `config.apply`;
   * both jobs resolve `undefined` and the final config contains `alpha` **and** `beta` (`hash-2`).
2. **`rejected-action`** — a transform throws `invalid configuration: mcp.servers.broken is not an object`.
   Assertions:
   * `assert.rejects` matches the original message (no silent retry, no swallowed error);
   * the recorded RPC sequence for that job is only `['config.get']` — nothing was patched or applied;
   * gateway revision and hash are unchanged (no mutation);
   * a *subsequent* job enqueued after the rejection succeeds normally against the un-mutated config
     (`['config.get','config.patch','config.get','config.apply']`), showing the queue recovered.

Raw run captured in `.prale-eval/demo-output.txt`.

## 3. Normalized operation result

```json
{
  "demo": "server/core/config-queue.js contract",
  "covered": ["ordered updates", "one rejected configuration action"],
  "total_patches": 3,
  "checks": {
    "ordered-updates": {
      "status": "pass",
      "call_sequence": ["config.get","config.patch","config.get","config.apply",
                        "config.get","config.patch","config.get","config.apply"],
      "final_hash": "hash-2"
    },
    "rejected-action": {
      "status": "pass",
      "rejected_calls": ["config.get"],
      "recovery_sequence": ["config.get","config.patch","config.get","config.apply"],
      "recovered": true
    }
  },
  "status": "pass"
}
```

`total_patches: 3` also confirms the built-in throttle window (`_MAX_PATCHES = 3` per 60 s, L10–12,
`_waitForSlot` L46–54) was not tripped: the third patch still has only two timestamps recorded, so no
artificial wait was introduced into the demo.

## 4. Evidence citations (independently checked)

`node .prale-eval/verify-result.mjs` re-reads `.prale-eval/result.json` and asserts that each cited
symbol literally occurs inside its inclusive line range of the real file:

* `server/core/config-queue.js:15-20` — `ConfigQueue.enqueue`
* `server/core/config-queue.js:24-37` — `ConfigQueue._process`
* `server/core/config-queue.js:60-99` — `ConfigQueue._execute`

It also asserts `task_id === 18`, `repository === "wattclaw"`, `mode === "contract"`, that every
claim cites a declared evidence path, and that `validation.command/status/notes` are present.

## 5. Limitations

* `node_modules` is empty in this checkout, so the repository's `vitest` suites and
  `npm run test:server` could not be executed and no dependency was installed; the demo uses only
  Node builtins (`node:assert`, `node:module`).
* `node --test` was not applicable to this module because `config-queue.js` resolves
  `./gateway-client.js` at load time (which transitively reaches `server/database.js` and the
  uninstalled `better-sqlite3`); the resolve hook isolates that single edge instead.
* Optional validation dependency unavailable → recorded here and in `result.json.validation.notes`.
* No task metadata, hidden-oracle file, package lock or git configuration was modified.
