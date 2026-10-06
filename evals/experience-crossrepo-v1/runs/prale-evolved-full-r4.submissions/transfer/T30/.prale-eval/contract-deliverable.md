# Contract deliverable — explicit CLI input overrides environment/config input (task T30)

Repository: `aider` · Mode: `contract` · Task: `T30`

Request: **Contract for a different boolean/tri-state option fixture: prove explicit CLI
input overrides environment/config input without changing unrelated defaults.**

## Fixture

| Property | Value |
| --- | --- |
| Option | `--attribute-author` (with `--no-attribute-author`) |
| `dest` | `attribute_author` |
| Declared in | `aider/args.py` → `get_parser`, lines **451–459** |
| `action` | `argparse.BooleanOptionalAction` |
| `default` | `None` → genuinely **tri-state**: unset / `True` / `False` |
| Env binding | `AIDER_ATTRIBUTE_AUTHOR` (via `auto_env_var_prefix="AIDER_"`) |
| Config binding | YAML key `attribute-author` (via `configargparse.YAMLConfigFileParser`) |

This fixture differs from the boolean options already pinned by the repository's tests
(`--auto-commits`, `--dirty-commits`, `--show-diffs`, `--dark-mode`): it is a tri-state
`BooleanOptionalAction` whose declared default is `None`, so the contract also covers the
"unset" state.

## Contract (normalized statement)

For the fixture key, with the three input sources layered by
`configargparse`’s documented per-key precedence **explicit CLI > environment > config file >
declared default**:

1. With no CLI token, env var or config entry, `attribute_author` resolves to the declared
   default `None`.
2. A config-file entry (`attribute-author: true`) alone sets the key to `True`.
3. An environment variable (`AIDER_ATTRIBUTE_AUTHOR=false`) alone sets the key to `False`.
4. `--attribute-author` overrides `AIDER_ATTRIBUTE_AUTHOR=false` → `True`.
5. `--no-attribute-author` overrides `AIDER_ATTRIBUTE_AUTHOR=true` → `False`.
6. `--no-attribute-author` overrides a config entry `attribute-author: true` → `False`.
7. `--attribute-author` overrides env + config that both request `false` → `True`.
8. In **every** scenario above, all 32 other `BooleanOptionalAction` options keep their
   declared defaults (e.g. `auto_commits`/`dirty_commits` stay `True`).

## Executable demo

`.prale-eval/demo_boolean_override.py` — standard-library only, exits `0` printing
`CONTRACT HOLDS`. Run from the repository root:

```
python .prale-eval/demo_boolean_override.py
```

It performs two kinds of work:

1. **Grounding in the real source.** It parses the actual `aider/args.py` with `ast` and
   extracts:
   * every `argparse.BooleanOptionalAction` option (flags, `dest`, declared default) — 33
     options, all with explicit defaults, including the fixture at lines 451–459;
   * the `configargparse.ArgumentParser(...)` wiring: `auto_env_var_prefix="AIDER_"`,
     `config_file_parser_class=configargparse.YAMLConfigFileParser`,
     `default_config_files=default_config_files`;
   * the CLI-selected source inputs `-c/--config` (`is_config_file=True`, lines 788–797) and
     `--env-file` (`default=default_env_file(git_root)`, lines 800–805).

2. **Executable precedence scenarios.** It builds a stdlib `argparse` parser from those real
   declared defaults and reproduces `configargparse`’s documented per-key precedence
   (CLI > env > config > default) for the fixture, asserting the eight contract points above
   — including the "no unrelated default changed" check on all 32 sibling options in every
   scenario.

Last recorded run:

```
CONTRACT HOLDS (24 checks passed)      # exit 0
```

## Validation

```
python .prale-eval/demo_boolean_override.py && python .prale-eval/validate_result.py
```

`validate_result.py` additionally re-checks `.prale-eval/result.json`: metadata must equal the
current `TASK.md` (`T30` / `aider` / `contract`), every cited symbol must really be defined
inside its inclusive line range in `aider/args.py`, `tests/basic/test_main.py` and
`aider/main.py`, both required paths must be covered by evidence and cited by at least one
claim, and the demo must still hold. Recorded output:

```
required paths covered: ['aider/args.py', 'tests/basic/test_main.py']
claims citing aider/args.py: 5
claims citing tests/basic/test_main.py: 2
evidence entries: 11 | claims: 5
executable demo: CONTRACT HOLDS
result.json schema OK
```

## Recorded limitation

`configargparse==1.7.5` and `shtab` are **not installed** in this sandbox, and installing
dependencies is out of scope. Consequently `aider/args.py`, `aider/main.py` and
`tests/basic/test_main.py` cannot be imported (they pull in `configargparse`, `shtab`,
`prompt_toolkit`, `GitPython`, `importlib_resources`, …) and the **live** `configargparse`
parse path could not be executed. Per the operating doctrine the limitation is recorded here
and in `result.json.validation.notes`; the contract is instead asserted with reduced-strength
substitute evidence: syntax parsing plus static assertions over the real declarations and a
stdlib reproduction of the documented precedence semantics. `tests/basic/test_main.py` is
cited as corroborating evidence from the repository's own acceptance tests
(`test_main_args`, `test_main_with_git_config_yml`, `test_true_vals_in_env_file`,
`test_false_vals_in_env_file`, `test_load_dotenv_files_override`), which pin the same
hierarchy for other boolean keys.

## Artifacts

| Path | Role |
| --- | --- |
| `.prale-eval/result.json` | Required structured evidence report (`task_id` T30, `repository` aider, `mode` contract). |
| `.prale-eval/contract-deliverable.md` | This document. |
| `.prale-eval/demo_boolean_override.py` | Executable contract demo (`CONTRACT HOLDS`). |
| `.prale-eval/validate_result.py` | Focused AST + schema validation (`result.json schema OK`). |

No source file, task metadata, hidden-oracle file, package lock or git configuration was
modified; the only changes are these new files under `.prale-eval/`.
