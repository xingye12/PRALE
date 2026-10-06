# T07 — Contract: explicit CLI input overrides env/config input

**Repository:** `aider`  **Mode:** `contract`  **Fixture:** a *new* boolean/tri-state
option fixture (`--suggest-shell-commands`, with the tri-state option `--analytics`
carried as the second, structurally different member of the same family).

---

## 1. Contract statement

> **C-T07.** For an option declared in `aider/args.py` with
> `action=argparse.BooleanOptionalAction`, an **explicit command-line occurrence of
> either polarity** (`--opt` or `--no-opt`) is the highest-precedence input source.
> It must override a value supplied through the environment (`AIDER_<OPT>`, generated
> by the parser's `auto_env_var_prefix="AIDER_"`) and a value supplied through a
> config file (`.aider.conf.yml`). Options that were **not** named on the command line
> must keep their declared defaults.

Precedence lattice, highest first:

| Rank | Source                       | Mechanism in `aider/args.py`                      |
|------|------------------------------|---------------------------------------------------|
| 1    | Explicit CLI flag            | `--opt` / `--no-opt` (`BooleanOptionalAction`)    |
| 2    | Environment                  | `AIDER_<OPT>` via `auto_env_var_prefix="AIDER_"`  |
| 3    | Config file                  | `.aider.conf.yml` via `default_config_files` + `YAMLConfigFileParser` |
| 4    | Declared default             | the `default=` keyword on the `add_argument` call |

The contract is **two-sided**: it constrains the overridden option *and* pins the
non-overridden options. A change that makes the CLI win by clobbering unrelated
options would satisfy "CLI overrides env" and still violate C-T07.

## 2. Fixture

| Role | Option | Action | Declared default | Env var | Cited at |
|------|--------|--------|------------------|---------|----------|
| Fixture (boolean) | `--suggest-shell-commands` | `BooleanOptionalAction` | `True` | `AIDER_SUGGEST_SHELL_COMMANDS` | `aider/args.py:806-811` |
| Fixture (tri-state) | `--analytics` | `BooleanOptionalAction` | `None` | `AIDER_ANALYTICS` | `aider/args.py:568-573` |
| Control (unrelated default) | `--detect-urls` | `BooleanOptionalAction` | `True` | `AIDER_DETECT_URLS` | `aider/args.py:842-847` |
| Control (unrelated default) | `--cache-prompts` | `BooleanOptionalAction` | `False` | `AIDER_CACHE_PROMPTS` | `aider/args.py:232-237` |

Why `--suggest-shell-commands` is the right fixture:

* its default is `True`, so an override is **observable** (`--no-…` must produce
  `False`, not merely "still the default");
* its value is forwarded verbatim into the coder —
  `aider/main.py:1000` `suggest_shell_commands=args.suggest_shell_commands` — so the
  result is readable as `coder.suggest_shell_commands`;
* the repository already ships a fixture *trio* pinning that observable
  (`tests/basic/test_main.py:735-763`), which T07 **extends** rather than replaces;
* it is a genuinely *different* option from the ones the existing env tests use
  (`--dark-mode`, `--show-diffs` at `tests/basic/test_main.py:421-462`), so it adds
  new coverage of the same mechanism.

`--analytics` is carried alongside because it is the **tri-state** member of the same
declaration family (`default=None` ⇒ `None` / `True` / `False`). The contract reads
identically for it; only the "unset" value differs (`None` instead of `True`).

## 3. Executable demo

```
python .prale-eval/contract_probe.py
```

`.prale-eval/contract_probe.py` is stdlib-only and self-contained. It runs three
layers and prints one line per check plus a JSON summary.

### Layer 1 — `declared` (always runs)

AST-parses the repository's own sources and asserts the declared shape of the
fixture: the env prefix (`get_parser` sets `auto_env_var_prefix="AIDER_"`), the action
class, the default, the derivation of `AIDER_SUGGEST_SHELL_COMMANDS`, the presence of
the existing test fixture trio at `tests/basic/test_main.py:735-763`, and the
`Coder.create` forwarding site in `aider/main.py`. Nothing is hard-coded from the
contract; every fact is read back out of the repository.

### Layer 2 — `cli` (always runs)

Re-hosts the **declarations extracted from `aider/args.py`** on a stock `argparse`
parser and executes the polarities. This proves the CLI-input half of the contract
without needing the third-party runtime:

| argv | `suggest_shell_commands` | `detect_urls` | `cache_prompts` | meaning |
|------|--------------------------|---------------|-----------------|---------|
| `[]` | `True` | `True` | `False` | declared defaults |
| `--no-suggest-shell-commands` | **`False`** | `True` | `False` | explicit negative wins over a `True` default; controls unmoved |
| `--suggest-shell-commands` | `True` | `True` | `False` | explicit positive is a no-op vs default |
| `--no-suggest-shell-commands --no-detect-urls` | `False` | `False` | `False` | independent flags move independently |

Tri-state variant (`--analytics`): `["--analytics"] → True`,
`["--no-analytics"] → False`, `[] → None`.

### Layer 3 — `precedence` (dependency gated)

Drives the **real** configargparse-backed `aider.args.get_parser`, and then
`aider.main.main(..., return_coder=True)` end to end, to prove the *full* lattice:
env honored when the CLI is silent, explicit CLI beating an opposed env value in both
directions, explicit CLI beating an opposed `.aider.conf.yml` value, and the control
options untouched. Claims checked there:

```
AIDER_SUGGEST_SHELL_COMMANDS=true  + []                          -> True
AIDER_SUGGEST_SHELL_COMMANDS=false + []                          -> False
AIDER_SUGGEST_SHELL_COMMANDS=true  + --no-suggest-shell-commands -> False   <-- core
AIDER_SUGGEST_SHELL_COMMANDS=false + --suggest-shell-commands    -> True    <-- core
aider.conf.yml: suggest-shell-commands: false + --suggest-shell-commands -> True
detect_urls is True and cache_prompts is False throughout                    <-- unrelated defaults
```

Layer 3 is **skipped and reported, never silently passed**, when the interpreter
lacks the runtime (see §5).

## 4. Normalized operation result

Observed run in this environment (exit code **0**):

```
status: partial   passed: 18   failed: 0   skipped: [runtime]
```

* Layer 1 `declared` — **10/10 PASS**, including
  `aider/args.py:806-811 declares ['--suggest-shell-commands'] action=argparse.BooleanOptionalAction default=True env=AIDER_SUGGEST_SHELL_COMMANDS`
  and `aider/main.py forwards args.suggest_shell_commands into Coder.create (kwarg at line 1000)`.
* Layer 2 `cli` — **8/8 PASS**, i.e. the four cli rows of the table above plus the
  three tri-state rows and the dest-name check.
* Layer 3 `precedence` — **SKIPPED** (missing `configargparse`, `shtab`, `git`,
  `importlib_resources`).

Normalized verdict for the checks that could execute: **the declared shape and the
explicit-CLI-polarity half of C-T07 hold; the env/config-half is asserted by
construction and by the repository's existing env fixture, but was not executed
here.** No check regressed and no unrelated default moved.

## 5. Validation limitation (recorded, not papered over)

This environment is missing the runtime dependencies `configargparse`, `shtab`,
`git` (GitPython) and `importlib_resources`. This task explicitly forbids installing
dependencies, and `aider.args` / `aider.main` cannot be imported without them, so:

* the configargparse precedence layer (Layer 3) could not be executed;
* the repository's own focused selection could not even be collected:

  ```
  $ python -m pytest tests/basic/test_main.py -k suggest_shell_commands -q
  ImportError while importing test module '.../tests/basic/test_main.py'
  tests/basic/test_main.py:10: in <module>
      import git
  E   ModuleNotFoundError: No module named 'git'
  ERROR tests/basic/test_main.py
  ```

Layers 1 and 2 are the compensations: they read the *real declarations out of the
repository* (so they cannot drift from `aider/args.py`) and execute them, giving a
runnable partial proof in place of the un-runnable full one. Anyone with the project
requirements installed can run `python .prale-eval/contract_probe.py` and the skip
becomes a pass/fail.

## 6. Scope / non-changes

No file outside `.prale-eval/` was created or modified: `aider/args.py`,
`aider/main.py`, `tests/basic/test_main.py`, task metadata, package locks and git
configuration are all untouched (`git status` is clean apart from the new
`.prale-eval/` artifacts). The existing fixture trio at
`tests/basic/test_main.py:735-763` is cited as the acceptance contract and is not
edited.
