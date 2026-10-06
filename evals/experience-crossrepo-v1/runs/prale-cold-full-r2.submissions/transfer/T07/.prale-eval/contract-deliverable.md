# T07 — Contract: explicit CLI input overrides env/config for a boolean/tri-state option

- Repository: `aider` (fixture baseline `48977eb`)
- Mode: `contract`
- Deliverable: executable demo + written contract for a boolean/tri-state option fixture
- Artifacts: `.prale-eval/contract_demo.py` (runner), `.prale-eval/demo-run.json` (last run record), this file, `.prale-eval/result.json`

## 1. The fixture

The task asks for **a different** boolean/tri-state option fixture than the ones the suite
already covers (`--show-diffs` + `AIDER_SHOW_DIFFS`, exercised by
`tests/basic/test_main.py::TestMain.test_true_vals_in_env_file` / `test_false_vals_in_env_file`,
and `--auto-commits`/`--dirty-commits`, exercised by `test_main_args`).

Chosen fixture — the tri-state option `--analytics`:

| Aspect | Value |
| --- | --- |
| CLI spelling | `--analytics` / `--no-analytics` |
| Declaration | `aider/args.py:568-573`, `argparse.BooleanOptionalAction`, `default=None` |
| States | `None` = unset/ask (the documented "random" default), `True` = force on, `False` = force off |
| Environment input | `AIDER_ANALYTICS` (from `auto_env_var_prefix="AIDER_"`, `aider/args.py:41`) |
| Config input | `analytics: <bool>` in `.aider.conf.yml` (YAML, `configargparse.YAMLConfigFileParser`, `aider/args.py:40`) |
| Consumer | `aider/main.py:642` → `aider/analytics.py:119-131` (`need_to_ask`, which compares with `is False` / `is True` and asserts `None`) |

Because the fixture is tri-state it has three interesting override cases instead of two:
`--analytics` must beat a `false` env/config value, `--no-analytics` must beat a `true`
env/config value, and *no* CLI/env/config input at all must still yield `None`.

## 2. The contract

For `--analytics` in `aider/args.py::get_parser`:

1. **Precedence** — explicit CLI token > environment variable (`AIDER_ANALYTICS`) > YAML config
   file (`analytics:`) > declared default (`None`).
   Grounded in: `get_parser` wiring env/config as parser defaults
   (`aider/args.py:35-42`) and `aider/main.py::main` loading `.env` files and then parsing
   `argv` last (`aider/main.py:451-504`, `load_dotenv_files` at `501` < final `parser.parse_args(argv)` at `504`).
2. **Override** — an explicit CLI token wins even against *both* an env var and a config file
   disagreeing with it, and the negative spelling is a real, explicit CLI value (not "absent"):
   - `AIDER_ANALYTICS=false` + `analytics: false` + `--analytics` ⇒ `True`
   - `AIDER_ANALYTICS=true` + `analytics: true` + `--no-analytics` ⇒ `False`
   - `AIDER_ANALYTICS=false` + `analytics: true` (no CLI) ⇒ `False` (env beats config)
3. **No collateral change** — overriding only `--analytics` leaves every unrelated option at its
   declared default: `auto_commits=True`, `dirty_commits=True`, `git=True`, `gitignore=True`,
   `check_update=True`, `dry_run=False`, `attribute_author=None`
   (declarations at `aider/args.py:395-400`, `439-450`, `451-459`, `604-609`; the
   "flip only the named option" acceptance pattern is `tests/basic/test_main.py::test_main_args`).
4. **Value normalisation** — env/config strings are coerced to real booleans, never left as
   truthy strings: `aider/analytics.py::need_to_ask` compares `is False` / `is True` and asserts
   `args_analytics is None` otherwise, while `tests/basic/test_main.py::setUp` sets
   `AIDER_ANALYTICS="false"` for the whole suite.

## 3. The executable demo

`.prale-eval/contract_demo.py` (stdlib-only, run from the repository root):

```bash
python .prale-eval/contract_demo.py --static          # static contract checks (works everywhere)
python .prale-eval/contract_demo.py --out .prale-eval/demo-run.json   # + runtime precedence matrix
python .prale-eval/contract_demo.py --e2e             # optional: drive aider.main.main end to end
```

It prints a JSON verdict and exits non-zero if any check that could run failed.

### 3a. Static checks (twelve, all pass in this environment)

Parsed with `ast` from the repository sources:

- `get_parser` configures `auto_env_var_prefix="AIDER_"` (env input) and
  `configargparse.YAMLConfigFileParser` (config input) — `aider/args.py:35-42`.
- `--analytics` is `argparse.BooleanOptionalAction` with `default=None` (tri-state), and therefore
  also exposes `--no-analytics` — `aider/args.py:568-573`.
- Unrelated defaults are declared exactly as asserted: `--auto-commits`/`--dirty-commits`
  `default=True`, `--git`/`--gitignore` `default=True`, `--check-update` `default=True`,
  `--dry-run` `default=False`, `--attribute-author` `default=None`.
- The already-fixtured `--show-diffs` is a *different*, two-state option
  (`store_true`, `default=False`) — `aider/args.py:395-400`.
- `aider.main.main` calls `load_dotenv_files` (line 501) **before** the final
  `parser.parse_args(argv)` (line 504) — CLI is applied last, i.e. it wins.
- `tests/basic/test_main.py::test_main_args` asserts `kwargs["auto_commits"] is False/True`,
  `kwargs["dirty_commits"] is True/False`; `setUp` pins `AIDER_ANALYTICS`; the suite covers
  `AIDER_SHOW_DIFFS=on/off` and `test_yaml_config_file_loading`.

### 3b. Runtime precedence matrix (six rows)

Each row runs the real `aider.args.get_parser` in a temp cwd (config supplied through
`default_config_files`, all ambient `AIDER_*` variables cleared first) and compares the observed
namespace with the contract:

| Row | `AIDER_ANALYTICS` | config `analytics:` | argv | expect `analytics` |
| --- | --- | --- | --- | --- |
| `defaults_only` | — | — | — | `None` |
| `env_only` | `false` | — | — | `False` |
| `config_only` | — | `true` | — | `True` |
| `env_beats_config` | `false` | `true` | — | `False` |
| `cli_true_beats_env_and_config` | `false` | `false` | `--analytics` | `True` |
| `cli_false_beats_env_and_config` | `true` | `true` | `--no-analytics` | `False` |

Every row additionally re-asserts all seven unrelated defaults from §2.3, so a passing row proves
both "explicit CLI input wins" and "unrelated defaults are unchanged". The `--e2e` flag adds one
`aider.main.main(["--no-analytics", "--config", <file>])` run with `AIDER_ANALYTICS=true` and
`analytics: true`, expecting `coder.args.analytics is False`.

## 4. Validation performed here and its limitation

| Command | Result |
| --- | --- |
| `python .prale-eval/contract_demo.py --static` | **exit 0**, 12/12 static contract checks pass |
| `python .prale-eval/contract_demo.py --out .prale-eval/demo-run.json` | exit 0; `static.ok=true`; `runtime.status="blocked: runtime dependencies unavailable"` |
| `python -m pytest tests/basic/test_main.py -k "test_main_args or test_true_vals_in_env_file or test_yaml_config_file_loading" -q` | **collection error**: `ModuleNotFoundError: No module named 'git'` (`tests/basic/test_main.py:10`) |

**Recorded limitation (optional validation dependency unavailable).** The runtime precedence matrix
(§3b) and the project test-suite validation could not be executed in this sandbox because the
repository's runtime dependencies are not installed — `configargparse` (pinned `==1.7.5` in
`requirements.txt:70`), `shtab`, `litellm` and `GitPython` (`git`) are all missing, and installing
dependencies or reaching outside the workspace is out of scope for this task. The demo handles this
explicitly: it reports `runtime.status = "blocked: runtime dependencies unavailable"`, names the
first missing module, and still fails loudly if the matrix runs and any row mismatches. No
dependency was installed; nothing outside the workspace was read or written; no repository source,
task metadata, hidden-oracle file, lock file or git configuration was modified (the only changes are
the new `.prale-eval/` artifacts).
