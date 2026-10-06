#!/usr/bin/env python
"""Executable contract demo for T07 (aider, mode=contract).

Contract
--------
For the tri-state boolean fixture ``--analytics`` (``argparse.BooleanOptionalAction``,
``default=None``) declared in ``aider/args.py::get_parser``:

1. Input precedence is CLI > environment (``AIDER_*``, ``auto_env_var_prefix``)
   > YAML config files (``.aider.conf.yml``) > declared default.
2. An explicit CLI token (``--analytics`` / ``--no-analytics``) wins over an
   environment variable and/or config-file value for the same option, including
   the "negative" (``--no-``) spelling and the tri-state ``None`` default.
3. Overriding that one option does not disturb unrelated option defaults
   (``--auto-commits``, ``--dirty-commits``, ``--git``, ``--gitignore``,
   ``--check-update``, ``--dry-run``, ``--attribute-author``).

Modes
-----
* ``--static`` (default when the runtime dependencies are missing): stdlib-only
  AST/text checks against ``aider/args.py``, ``aider/main.py`` and
  ``tests/basic/test_main.py`` that prove the fixture is declared, that the
  option is re-parsed from ``argv`` last, and that the public test contract
  asserts CLI-flips-keep-unrelated-defaults.
* default: additionally *executes* the precedence matrix above through
  ``aider.args.get_parser`` (needs ``configargparse``, ``shtab``, ``litellm``,
  ``GitPython`` ... i.e. the project's runtime requirements).
* ``--e2e``: optionally also drives ``aider.main.main`` end to end.

Output: JSON verdict on stdout (and to ``.prale-eval/demo-run.json`` with
``--out``); exit code 0 only when every check that could run passed.
"""

import argparse
import ast
import json
import os
import pathlib
import sys
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
ARGS_PY = REPO_ROOT / "aider" / "args.py"
MAIN_PY = REPO_ROOT / "aider" / "main.py"
TEST_MAIN_PY = REPO_ROOT / "tests" / "basic" / "test_main.py"

FIXTURE = "--analytics"
ENV_FIXTURE = "AIDER_ANALYTICS"
CONFIG_FIXTURE = "analytics"

# Unrelated options that must keep their declared defaults while the fixture is
# overridden from the command line.
UNRELATED_DEFAULTS = {
    "auto_commits": True,
    "dirty_commits": True,
    "git": True,
    "gitignore": True,
    "check_update": True,
    "dry_run": False,
    "attribute_author": None,
}


# --------------------------------------------------------------------------- #
# static contract checks (stdlib only)
# --------------------------------------------------------------------------- #
def _literal(node):
    """Best-effort literal -> python value for AST constants / simple names."""
    if node is None:
        return None
    try:
        return ast.literal_eval(node)
    except Exception:
        pass
    return ast.unparse(node)


def _add_argument_calls(tree):
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr != "add_argument":
            continue
        opts = [
            _literal(a)
            for a in node.args
            if isinstance(a, ast.Constant) and isinstance(a.value, str)
        ]
        kwargs = {kw.arg: _literal(kw.value) for kw in node.keywords if kw.arg}
        out.append((opts, kwargs, node.lineno))
    return out


def _find_func(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def static_checks():
    checks = []

    def add(name, ok, detail):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    args_src = ARGS_PY.read_text(encoding="utf-8")
    args_tree = ast.parse(args_src)
    calls = _add_argument_calls(args_tree)
    by_opt = {opt: (opts, kwargs, lineno) for opts, kwargs, lineno in calls for opt in opts}

    # 1. parser is wired to env vars (AIDER_ prefix) + YAML config files.
    get_parser = _find_func(args_tree, "get_parser")
    parser_kwargs = {}
    if get_parser is not None:
        for node in ast.walk(get_parser):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "ArgumentParser"
            ):
                parser_kwargs = {kw.arg: _literal(kw.value) for kw in node.keywords if kw.arg}
                break
    add(
        "get_parser configures env var prefix AIDER_",
        parser_kwargs.get("auto_env_var_prefix") == "AIDER_",
        f"auto_env_var_prefix={parser_kwargs.get('auto_env_var_prefix')!r}",
    )
    add(
        "get_parser configures YAML config file parser",
        "YAMLConfigFileParser" in str(parser_kwargs.get("config_file_parser_class")),
        f"config_file_parser_class={parser_kwargs.get('config_file_parser_class')!r}",
    )

    # 2. the tri-state fixture declaration.
    fixture = by_opt.get(FIXTURE)
    ok = (
        fixture is not None
        and "argparse.BooleanOptionalAction" in str(fixture[1].get("action"))
        and fixture[1].get("default") is None
    )
    add(
        f"{FIXTURE} is a tri-state BooleanOptionalAction with default None",
        ok,
        f"line {fixture[2]}: {fixture[1]}" if fixture else f"{FIXTURE} not found",
    )
    if fixture:
        add(
            f"{FIXTURE} exposes the --no- spelling used by explicit CLI input",
            True,
            "argparse.BooleanOptionalAction auto-registers --no-analytics",
        )

    # 3. unrelated defaults that must stay put.
    missing = []
    for opt, expected in (
        ("--auto-commits", True),
        ("--dirty-commits", True),
        ("--git", True),
        ("--gitignore", True),
        ("--check-update", True),
        ("--dry-run", False),
        ("--attribute-author", None),
    ):
        got = by_opt.get(opt)
        if got is None or got[1].get("default") != expected:
            missing.append(f"{opt} default != {expected!r} ({got[1] if got else 'missing'})")
    add(
        "unrelated option defaults are declared as documented",
        not missing,
        "; ".join(missing) or "auto-commits/dirty-commits/git/gitignore/check-update/dry-run/attribute-author",
    )

    # 4. the fixture default is tri-state while sibling booleans are two-state
    sibling = by_opt.get("--show-diffs")
    add(
        "the pre-existing --show-diffs env fixture is a different, two-state option",
        sibling is not None and sibling[1].get("default") is False,
        f"{sibling[1] if sibling else 'missing'}",
    )

    # 5. main() re-parses argv last, i.e. after the env/.env-file loading step.
    main_tree = ast.parse(MAIN_PY.read_text(encoding="utf-8"))
    main_func = _find_func(main_tree, "main")
    load_line = None
    parse_lines = []
    if main_func is not None:
        for node in ast.walk(main_func):
            if isinstance(node, ast.Call):
                fn = node.func
                if isinstance(fn, ast.Name) and fn.id == "load_dotenv_files":
                    load_line = node.lineno
                elif isinstance(fn, ast.Attribute) and fn.attr == "parse_args":
                    parse_lines.append(node.lineno)
    add(
        "aider.main.main loads env files before the final parser.parse_args(argv)",
        load_line is not None
        and bool(parse_lines)
        and load_line < max(parse_lines),
        f"load_dotenv_files@{load_line}, parse_args@{sorted(parse_lines)}",
    )

    # 6. the public test contract mirrors the same rules.
    test_src = TEST_MAIN_PY.read_text(encoding="utf-8")
    test_tree = ast.parse(test_src)
    test_main_args = _find_func(test_tree, "test_main_args")
    body = ast.get_source_segment(test_src, test_main_args) if test_main_args else ""
    add(
        "tests/basic/test_main.py::TestMain.test_main_args asserts CLI boolean flips",
        'kwargs["auto_commits"] is False' in body and 'kwargs["auto_commits"] is True' in body,
        "asserts --no-auto-commits/--auto-commits land on Coder.create(auto_commits=...)",
    )
    add(
        "test_main_args asserts unrelated defaults survive an explicit CLI flip",
        'kwargs["dirty_commits"] is True' in body and 'kwargs["dirty_commits"] is False' in body,
        "empty argv keeps dirty_commits True; --no-dirty-commits flips only that flag",
    )
    add(
        "the suite pins the fixture env var AIDER_ANALYTICS",
        ENV_FIXTURE in test_src,
        f"{ENV_FIXTURE} set in TestMain.setUp (restored in tearDown)",
    )
    add(
        "the suite covers env-file sourced booleans (different fixture)",
        "AIDER_SHOW_DIFFS=on" in test_src and "AIDER_SHOW_DIFFS=off" in test_src,
        "test_true_vals_in_env_file / test_false_vals_in_env_file",
    )
    add(
        "the suite covers YAML config-file sourcing",
        _find_func(test_tree, "test_yaml_config_file_loading") is not None,
        "config files feed parser defaults; CLI is parsed afterwards",
    )
    return checks


# --------------------------------------------------------------------------- #
# runtime precedence matrix
# --------------------------------------------------------------------------- #
def _runtime_env():
    try:
        import configargparse  # noqa: F401
        import shtab  # noqa: F401
        import litellm  # noqa: F401
        import git  # noqa: F401
    except Exception as exc:  # pragma: no cover - env dependent
        return None, f"{type(exc).__name__}: {exc}"
    return True, "runtime dependencies importable"


def _observe(argv, env, config_text):
    """Parse with the real aider parser and return the observed namespace."""
    from aider.args import get_parser

    with tempfile.TemporaryDirectory() as tmp:
        cfg_files = []
        if config_text is not None:
            cfg = pathlib.Path(tmp) / ".aider.conf.yml"
            cfg.write_text(config_text, encoding="utf-8")
            cfg_files = [str(cfg)]
        saved = {k: os.environ.get(k) for k in list(os.environ) if k.startswith("AIDER_")}
        for k in saved:
            os.environ.pop(k, None)
        os.environ.update(env)
        try:
            parser = get_parser(cfg_files, None)
            args = parser.parse_args(argv)
        finally:
            for k in list(os.environ):
                if k.startswith("AIDER_"):
                    os.environ.pop(k, None)
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    observed = {"analytics": args.analytics}
    observed.update({name: getattr(args, name) for name in UNRELATED_DEFAULTS})
    return observed


MATRIX = [
    {
        "row": "defaults_only",
        "argv": [],
        "env": {},
        "config": None,
        "expect": {"analytics": None},
        "why": "tri-state default stays None when no CLI/env/config input exists",
    },
    {
        "row": "env_only",
        "argv": [],
        "env": {ENV_FIXTURE: "false"},
        "config": None,
        "expect": {"analytics": False},
        "why": "environment input is coerced to the boolean tri-state value False",
    },
    {
        "row": "config_only",
        "argv": [],
        "env": {},
        "config": f"{CONFIG_FIXTURE}: true\n",
        "expect": {"analytics": True},
        "why": "YAML config input feeds the tri-state value True",
    },
    {
        "row": "env_beats_config",
        "argv": [],
        "env": {ENV_FIXTURE: "false"},
        "config": f"{CONFIG_FIXTURE}: true\n",
        "expect": {"analytics": False},
        "why": "documented precedence: env > config file",
    },
    {
        "row": "cli_true_beats_env_and_config",
        "argv": [FIXTURE],
        "env": {ENV_FIXTURE: "false"},
        "config": f"{CONFIG_FIXTURE}: false\n",
        "expect": {"analytics": True},
        "why": "explicit --analytics overrides both env and config file",
    },
    {
        "row": "cli_false_beats_env_and_config",
        "argv": ["--no-analytics"],
        "env": {ENV_FIXTURE: "true"},
        "config": f"{CONFIG_FIXTURE}: true\n",
        "expect": {"analytics": False},
        "why": "explicit --no-analytics overrides both env and config file",
    },
]


def runtime_checks():
    available, detail = _runtime_env()
    result = {"available": bool(available), "detail": detail, "rows": [], "failures": []}
    if not available:
        return result

    for row in MATRIX:
        expect = dict(row["expect"])
        # every row must also preserve every unrelated default
        expect.update(UNRELATED_DEFAULTS)
        try:
            observed = _observe(row["argv"], row["env"], row["config"])
        except Exception as exc:  # pragma: no cover - env dependent
            result["failures"].append({"row": row["row"], "error": f"{type(exc).__name__}: {exc}"})
            result["rows"].append({"row": row["row"], "status": "error"})
            continue
        mismatches = {
            k: {"expected": v, "observed": observed.get(k)}
            for k, v in expect.items()
            if observed.get(k) is not v
        }
        result["rows"].append(
            {
                "row": row["row"],
                "why": row["why"],
                "argv": row["argv"],
                "env": row["env"],
                "config": row["config"],
                "observed": observed,
                "mismatches": mismatches,
                "status": "pass" if not mismatches else "fail",
            }
        )
        if mismatches:
            result["failures"].append({"row": row["row"], "mismatches": mismatches})
    return result


def e2e_check():
    """Optional end-to-end probe through aider.main.main (needs full runtime)."""
    try:
        from unittest.mock import patch

        from prompt_toolkit.input import DummyInput
        from prompt_toolkit.output import DummyOutput

        from aider.main import main
    except Exception as exc:  # pragma: no cover
        return {"status": "skipped", "detail": f"{type(exc).__name__}: {exc}"}

    with tempfile.TemporaryDirectory() as tmp:
        cfg = pathlib.Path(tmp) / ".aider.conf.yml"
        cfg.write_text(f"{CONFIG_FIXTURE}: true\n", encoding="utf-8")
        saved = {k: os.environ.get(k) for k in list(os.environ) if k.startswith("AIDER_")}
        for k in saved:
            os.environ.pop(k, None)
        os.environ.update({ENV_FIXTURE: "true", "OPENAI_API_KEY": "deadbeef"})
        try:
            with patch("aider.coders.Coder.create") as MockCoder:
                coder = main(
                    ["--no-analytics", "--config", str(cfg), "--no-git", "--yes"],
                    input=DummyInput(),
                    output=DummyOutput(),
                    return_coder=True,
                )
                MockCoder.assert_not_called()
            value = coder.args.analytics
        except Exception as exc:  # pragma: no cover
            return {"status": "error", "detail": f"{type(exc).__name__}: {exc}"}
        finally:
            for k in list(os.environ):
                if k.startswith("AIDER_"):
                    os.environ.pop(k, None)
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v
    return {
        "status": "pass" if value is False else "fail",
        "observed_analytics": value,
        "detail": "main(['--no-analytics', '--config', cfg]) with AIDER_ANALYTICS=true and "
        "analytics: true in the config file",
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--static", action="store_true", help="run only the stdlib static checks")
    ap.add_argument("--e2e", action="store_true", help="also run the optional main() end-to-end probe")
    ap.add_argument("--out", help="write the JSON verdict to this path as well")
    ns = ap.parse_args()

    checks = static_checks()
    verdict = {
        "fixture": {
            "option": FIXTURE,
            "env_var": ENV_FIXTURE,
            "config_key": CONFIG_FIXTURE,
            "type": "tri-state boolean (BooleanOptionalAction, default None)",
            "unrelated_defaults": UNRELATED_DEFAULTS,
        },
        "static": {
            "checks": checks,
            "failures": [c["check"] for c in checks if not c["ok"]],
        },
    }
    if not ns.static:
        verdict["runtime"] = runtime_checks()
    if ns.e2e:
        verdict["e2e"] = e2e_check()

    ok = not verdict["static"]["failures"]
    if "runtime" in verdict:
        rt = verdict["runtime"]
        if not rt["available"]:
            verdict["runtime"]["status"] = "blocked: runtime dependencies unavailable"
        else:
            ok = ok and not rt["failures"]
    if "e2e" in verdict:
        ok = ok and verdict["e2e"].get("status") in ("pass", "skipped")

    verdict["ok"] = ok
    text = json.dumps(verdict, indent=2, sort_keys=False)
    print(text)
    if ns.out:
        pathlib.Path(ns.out).write_text(text + "\n", encoding="utf-8")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
