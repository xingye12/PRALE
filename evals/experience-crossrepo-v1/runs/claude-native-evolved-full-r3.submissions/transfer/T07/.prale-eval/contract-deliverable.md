# T07 — Contract: explicit CLI input overrides env/config input (tri-state boolean)

**Repository:** `aider` · **Mode:** `contract` · **Task:** `T07`

## 1. Fixture and contract statement

**Fixture option:** `--analytics` (dest `analytics`), declared in `aider/args.py`.

```python
group.add_argument(
    "--analytics",
    action=argparse.BooleanOptionalAction,   # gives --analytics / --no-analytics
    default=None,                            # tri-state: None | True | False
    help="Enable/disable analytics for current session (default: random)",
)
```

**Contract.** For this tri-state boolean, the value aide resolves follows the
`configargparse` precedence ladder used by `aider.args.get_parser`:

```
explicit CLI argument   >   environment variable   >   config file   >   declared default
```

Concretely:

| Tier supplied                              | Resolved `analytics` |
|--------------------------------------------|----------------------|
| nothing                                    | `None` (tri-state default, "random" prompt) |
| config `.aider.conf.yml`: `analytics: true`| `True` |
| env `AIDER_ANALYTICS=true` (beats config)  | `True` |
| env `AIDER_ANALYTICS=true` **+** CLI `--no-analytics` | `False` (CLI wins) |
| env/config `false` **+** CLI `--analytics` | `True` (CLI wins) |
| CLI `--no-analytics`, nothing else         | `False` |

**Invariants the contract must preserve:**

1. An explicit CLI argument is never shadowed by an environment variable or a
   config-file value.
2. Both polarities are expressible on the CLI (`--analytics` / `--no-analytics`),
   so a `True` inherited from env/config can be explicitly turned off.
3. An option that receives no value from any tier keeps its **declared** default
   (`None` for the fixture).
4. **Unrelated options are untouched** — supplying/overriding `--analytics` does
   not perturb the declared defaults of other options (`--auto-commits` stays
   `True`, `--dark-mode` stays `False`, `--pretty` stays `True`, …).

### Why the ladder holds in this repository

- `get_parser` builds a `configargparse.ArgumentParser` with
  `config_file_parser_class=configargparse.YAMLConfigFileParser`,
  `default_config_files=…`, and `auto_env_var_prefix="AIDER_"`
  (`aider/args.py:35-41`). `configargparse` itself resolves CLI above env above
  config file.
- `aider.main()` additionally loads `.env` files into the process environment
  (`load_dotenv(..., override=True)`) and then re-parses, so `.env` values join
  the *env* tier and therefore also lose to an explicit CLI flag.
- The negated form comes from `argparse.BooleanOptionalAction`, which is what
  makes the fixture genuinely tri-state rather than a plain `store_true` flag.

## 2. Executable demo

` .prale-eval/contract_demo.py` — run with:

```
python .prale-eval/contract_demo.py
```

The demo has three legs:

| Leg | What it does | Needs |
|-----|--------------|-------|
| `source-declaration` | Reads `aider/args.py`, locates the `--analytics` declaration and asserts `action=argparse.BooleanOptionalAction`, `default=None`, and `auto_env_var_prefix="AIDER_"`. Grounds the fixture in the real source. | stdlib |
| `tiers-configargparse` | Builds the **real** `aider.args.get_parser(default_config_files=[conf.yml], …)`, sets config `analytics: true` and env `AIDER_ANALYTICS=true`, then parses `[]`, `--no-analytics`, `--analytics` and checks the ladder. | `configargparse` (not installed here) |
| `argparse-tristate-and-defaults` | Mirrors the exact fixture + unrelated declarations with stdlib `argparse` and checks tri-state (`None`), explicit override of an inherited `True`, and that unrelated defaults (`--auto-commits`, `--dark-mode`, `--pretty`) are unchanged. | stdlib |

### Normalized operation result

```json
{
  "demo": "t07-tristate-cli-overrides-env-config",
  "legs": {
    "source-declaration": {"status": "PASS"},
    "tiers-configargparse": {"status": "SKIPPED", "reason": "configargparse not installed"},
    "argparse-tristate-and-defaults": {"status": "PASS"}
  },
  "overall": "PASS"
}
```

Observed stdout (exit code 0):

```
[PASS   ] source-declaration: aider/args.py:569 declares --analytics with BooleanOptionalAction=True, default=None=True; parser uses auto_env_var_prefix="AIDER_"=True
[SKIPPED] tiers-configargparse: configargparse is not installed in this environment (ModuleNotFoundError) ...
[PASS   ] argparse-tristate-and-defaults: {"default_is_tristate_None": true, "explicit_off_is_False": true, "explicit_on_is_True": true, "cli_off_overrides_inherited_True": true, "unrelated_default_auto_commits": true, "unrelated_default_dark_mode": true, "unrelated_default_pretty": true}
```

## 3. Validation and known limitation

- **Ran:** `python .prale-eval/contract_demo.py` → `PASS`, exit 0.
- **Attempted:** `python -m pytest tests/basic/test_main.py -k "env_file or dark_mode" -q`
  → collection error: the environment lacks `configargparse` **and** `git`
  (GitPython), so `tests/basic/test_main.py` cannot even be imported. The
  repository's own suite could not be executed here.
- **Limitation recorded:** the `tiers-configargparse` leg (the one that drives the
  real `aider` parser end-to-end) is **SKIPPED** because `configargparse` is not
  installed and this task forbids installing dependencies. The contract is still
  asserted by (a) the source-grounded declaration check against the real
  `aider/args.py`, and (b) the stdlib-`argparse` leg that reproduces the exact
  `BooleanOptionalAction` tri-state semantics and the untouched-default
  invariant. The existing repository test `test_main_args`
  (`tests/basic/test_main.py:263-290`) independently pins the same invariant for
  `--auto-commits` / `--dirty-commits`.

## 4. Evidence map

| Path | Symbol | Lines | Role |
|------|--------|-------|------|
| `aider/args.py` | `get_parser` | 35-41 | Wires the CLI > env > config > default ladder (YAML config files, `auto_env_var_prefix="AIDER_"`). |
| `aider/args.py` | `--analytics` | 569-573 | The tri-state fixture: `BooleanOptionalAction`, `default=None`. |
| `aider/args.py` | `--auto-commits` | 440-444 | Boolean with `default=True`; supports the "unrelated default unchanged" invariant. |
| `tests/basic/test_main.py` | `TestMain.setUp` | 22-38 | Pins `AIDER_ANALYTICS=false` and isolates `HOME` so env-tier resolution is deterministic. |
| `tests/basic/test_main.py` | `test_main_args` | 263-290 | Proves explicit CLI booleans override and untouched defaults stay put. |
| `tests/basic/test_main.py` | `test_true_vals_in_env_file` | 456-462 | Proves the env tier feeds boolean options (`AIDER_SHOW_DIFFS=on` → `show_diffs True`). |
