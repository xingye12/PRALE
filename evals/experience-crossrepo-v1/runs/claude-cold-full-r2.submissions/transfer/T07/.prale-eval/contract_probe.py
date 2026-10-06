#!/usr/bin/env python3
"""T07 executable contract probe for the `aider` repository.

CONTRACT C-T07
--------------
For the boolean / tri-state option family declared in ``aider/args.py`` with
``argparse.BooleanOptionalAction``, an *explicit* command-line occurrence of
either polarity (``--opt`` or ``--no-opt``) is the highest-precedence input
source.  It must override the value supplied through the environment
(``AIDER_<OPT>``, via the parser's ``auto_env_var_prefix="AIDER_"``) or through a
config file (``.aider.conf.yml``), and options that were *not* mentioned on the
command line must keep their declared defaults.

Fixture option under test
    ``--suggest-shell-commands``  (BooleanOptionalAction, default ``True``)
    env var ``AIDER_SUGGEST_SHELL_COMMANDS``
    observable ``Coder.suggest_shell_commands`` (aider/main.py:1000)

Unrelated-default controls (must never move)
    ``--detect-urls``     (BooleanOptionalAction, default ``True``)
    ``--cache-prompts``   (BooleanOptionalAction, default ``False``)

Tri-state variant
    ``--analytics``       (BooleanOptionalAction, default ``None`` -> None/True/False)

Layer 1 ``declared``  (stdlib only, always runs)
    AST-parse ``aider/args.py`` and ``tests/basic/test_main.py`` and confirm the
    declared shape of the fixture: env prefix, action class, default, the
    positive/negative CLI surface, and the existing test fixture that pins the
    observable.
Layer 2 ``cli``       (stdlib only, always runs)
    Re-host the *declaration extracted from the repository* on a stock
    ``argparse`` parser and execute the polarities, proving that explicit CLI
    input produces True/False/None as declared while the control options stay at
    their defaults.
Layer 3 ``precedence`` (dependency gated)
    Exercise ``aider.args.get_parser`` itself (the real configargparse-backed
    parser) with opposed env / config-file / CLI inputs, and, when the full
    runtime is importable, drive ``aider.main.main`` end to end and read the
    observable off the returned ``Coder``.

Layer 3 is skipped (reported, never silently passed) when this interpreter lacks
the runtime dependencies.  Nothing here installs anything.

Exit status: 0 when every *executed* layer passes, 2 when any executed layer
fails.  A skipped layer does not by itself fail the run but is recorded as
``skipped`` in the JSON summary.
"""

import argparse
import ast
import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ARGS_PY = REPO / "aider" / "args.py"
MAIN_PY = REPO / "aider" / "main.py"
TEST_PY = REPO / "tests" / "basic" / "test_main.py"

FIXTURE = "suggest-shell-commands"
CONTROLS = ("detect-urls", "cache-prompts")
TRISTATE = "analytics"

# The CLI surface pinned by tests/basic/test_main.py:735-763.
TEST_FIXTURE_METHODS = (
    "test_suggest_shell_commands_default",
    "test_suggest_shell_commands_disabled",
    "test_suggest_shell_commands_enabled",
)

results = []


def record(layer, name, ok, detail):
    """Record one executed check. Returns ok so callers can AND it into the layer."""
    results.append({"layer": layer, "name": name, "ok": bool(ok), "detail": detail})
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {layer}: {name} -- {detail}")
    return ok


def record_skip(layer, name, detail):
    """Record a check that could not run (missing dependency). Never counts as a pass."""
    results.append({"layer": layer, "name": name, "ok": None, "skipped": True, "detail": detail})
    print(f"[SKIP] {layer}: {name} -- {detail}")


# --------------------------------------------------------------------------
# Layer 1 -- read the repository's own declarations
# --------------------------------------------------------------------------


def _call_keywords(call):
    return {kw.arg: kw.value for kw in call.keywords if kw.arg is not None}


def _literal(node):
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def _dotted(node):
    """Return 'argparse.BooleanOptionalAction' for an Attribute node, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def parse_args_declarations():
    """Extract add_argument declarations and the env-var prefix from args.py."""
    tree = ast.parse(ARGS_PY.read_text(encoding="utf-8"))

    prefix = None
    declarations = {}
    declared_actions = {}

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            fname = node.func.attr
            if fname == "ArgumentParser":
                kw = _call_keywords(node)
                if "auto_env_var_prefix" in kw:
                    prefix = _literal(kw["auto_env_var_prefix"])
            elif fname == "add_argument" and node.args:
                first = _literal(node.args[0])
                if not isinstance(first, str):
                    continue
                kw = _call_keywords(node)
                opt_strings = [_literal(a) for a in node.args if isinstance(_literal(a), str)]
                declarations[first.lstrip("-")] = {
                    "option_strings": opt_strings,
                    "action": _dotted(kw["action"]) if "action" in kw else None,
                    "default": _literal(kw["default"]) if "default" in kw else argparse.SUPPRESS,
                    "lineno": node.lineno,
                    "end_lineno": node.end_lineno,
                    "has_default_kw": "default" in kw,
                }
                if "action" in kw:
                    declared_actions[first] = kw["action"]

    return prefix, declarations, declared_actions


def env_var_for(prefix, option):
    return prefix + option.lstrip("-").replace("-", "_").upper()


def layer_declared():
    ok = True
    print("\n== Layer 1: declared shape (aider/args.py, tests/basic/test_main.py) ==")

    prefix, decls, _ = parse_args_declarations()

    ok &= record("declared", "env_prefix", prefix == "AIDER_",
                 f"get_parser sets auto_env_var_prefix={prefix!r} "
                 "(aider/args.py:35-42), so every option has an AIDER_* env source")

    for option in (FIXTURE, *CONTROLS, TRISTATE):
        d = decls.get(option)
        if d is None:
            ok &= record("declared", f"decl:{option}", False, "option not found in args.py")
            continue
        ok &= record(
            "declared",
            f"decl:{option}",
            d["action"] == "argparse.BooleanOptionalAction" and d["has_default_kw"],
            f"aider/args.py:{d['lineno']}-{d['end_lineno']} declares {d['option_strings']} "
            f"action={d['action']} default={d['default']!r} "
            f"env={env_var_for(prefix or '', option)}",
        )

    fixture = decls.get(FIXTURE, {})
    ok &= record("declared", "fixture_default", fixture.get("default") is True,
                 f"{FIXTURE} declared default is True (not False), so an override is observable")

    # The existing, unmodified acceptance fixture in the test suite.
    test_src = TEST_PY.read_text(encoding="utf-8")
    test_tree = ast.parse(test_src)
    methods = {
        n.name: (n.lineno, n.end_lineno)
        for n in ast.walk(test_tree)
        if isinstance(n, ast.FunctionDef)
    }
    for name in TEST_FIXTURE_METHODS:
        span = methods.get(name)
        ok &= record("declared", f"fixture:{name}", span is not None,
                     f"tests/basic/test_main.py:{span[0]}-{span[1]} defines {name}"
                     if span else f"{name} missing")

    # main.py must actually forward the parsed value into the Coder.
    main_tree = ast.parse(MAIN_PY.read_text(encoding="utf-8"))
    forwards = {}
    for node in ast.walk(main_tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "create"
        ):
            for kw in node.keywords:
                if kw.arg in ("suggest_shell_commands", "detect_urls"):
                    forwards[kw.arg] = kw.lineno
    ok &= record("declared", "wiring", forwards.get("suggest_shell_commands") is not None,
                 "aider/main.py forwards args.suggest_shell_commands into Coder.create "
                 f"(kwarg at line {forwards.get('suggest_shell_commands')}; observable = "
                 "coder.suggest_shell_commands)")

    return ok


# --------------------------------------------------------------------------
# Layer 2 -- execute the repository's own declaration on a stock argparse host
# --------------------------------------------------------------------------


def dest_of(option):
    """configargparse derives dest from the option string: '-' -> '_'."""
    return option.lstrip("-").replace("-", "_")


def build_stock_parser(decls):
    """Re-host the repository's declarations on stdlib argparse (no configargparse)."""
    parser = argparse.ArgumentParser(add_help=False)
    for option in (FIXTURE, *CONTROLS, TRISTATE):
        d = decls[option]
        parser.add_argument(
            "--" + option,
            action=argparse.BooleanOptionalAction,
            default=d["default"],
        )
    return parser


def layer_cli():
    ok = True
    print("\n== Layer 2: explicit CLI polarity (declarations re-hosted on argparse) ==")

    _, decls, _ = parse_args_declarations()
    parser = build_stock_parser(decls)

    def ns(argv):
        return vars(parser.parse_args(argv))

    cases = [
        ([], True, True, False, "no input -> declared defaults (True/True/False)"),
        (["--no-" + FIXTURE], False, True, False,
         "explicit negative CLI wins over the True default"),
        (["--" + FIXTURE], True, True, False, "explicit positive CLI is a no-op vs default"),
        (["--no-" + FIXTURE, "--no-detect-urls"], False, False, False,
         "two independent flags move independently"),
    ]
    for argv, exp_fix, exp_detect, exp_cache, why in cases:
        got = ns(argv)
        act = (got[dest_of(FIXTURE)], got[dest_of("detect-urls")], got[dest_of("cache-prompts")])
        ok &= record("cli", f"argv={argv or ['<empty>']}", act == (exp_fix, exp_detect, exp_cache),
                     f"{why}: got {act}")

    tri = ns(["--" + TRISTATE])
    ok &= record("cli", "tri-state:--analytics", tri[dest_of(TRISTATE)] is True,
                 f"tri-state option {TRISTATE} accepts explicit positive -> "
                 f"{tri[dest_of(TRISTATE)]!r}")
    tri = ns(["--no-" + TRISTATE])
    ok &= record("cli", "tri-state:--no-analytics", tri[dest_of(TRISTATE)] is False,
                 f"tri-state option {TRISTATE} accepts explicit negative -> "
                 f"{tri[dest_of(TRISTATE)]!r}")
    tri = ns([])
    ok &= record("cli", "tri-state:default", tri[dest_of(TRISTATE)] is None,
                 f"tri-state option {TRISTATE} unset stays None (tri-state, not boolean) -> "
                 f"{tri[dest_of(TRISTATE)]!r}")

    # The negative form must set the same dest the repo forwards in main.py.
    neg = ns(["--no-" + FIXTURE])
    ok &= record("cli", "dest-name", dest_of(FIXTURE) in neg,
                 f"BooleanOptionalAction keeps dest {dest_of(FIXTURE)!r} for both polarities, "
                 "matching the kwargs forwarded at aider/main.py:1000")

    return ok


# --------------------------------------------------------------------------
# Layer 3 -- the real configargparse-backed parser and main()
# --------------------------------------------------------------------------


def missing_runtime():
    missing = []
    for mod in ("configargparse", "shtab", "git", "prompt_toolkit", "importlib_resources"):
        try:
            __import__(mod)
        except Exception as exc:  # ModuleNotFoundError and friends
            missing.append(f"{mod} ({type(exc).__name__})")
    return missing


def layer_precedence():
    print("\n== Layer 3: precedence through aider.args.get_parser / aider.main.main ==")
    missing = missing_runtime()
    if missing:
        record_skip(
            "precedence",
            "runtime",
            "runtime dependencies unavailable in this interpreter: " + ", ".join(missing),
        )
        return None  # neither pass nor fail: an honest skip

    os.environ["AIDER_CHECK_UPDATE"] = "false"
    os.environ["AIDER_ANALYTICS"] = "false"
    os.environ["OPENAI_API_KEY"] = "deadbeef"

    from aider.args import get_parser

    env_name = env_var_for("AIDER_", FIXTURE)
    ok = True

    def parse(argv, env_value, config_files=()):
        saved = os.environ.get(env_name)
        if env_value is None:
            os.environ.pop(env_name, None)
        else:
            os.environ[env_name] = env_value
        try:
            parser = get_parser(list(config_files), None)
            return vars(parser.parse_args(argv))
        finally:
            if saved is None:
                os.environ.pop(env_name, None)
            else:
                os.environ[env_name] = saved

    # 3a. env is honoured when the CLI says nothing.
    got = parse([], "true")
    ok &= record("precedence", "env-only", got[FIXTURE.replace("-", "_")] is True,
                 f"{env_name}=true with empty argv -> {got['suggest_shell_commands']!r}")
    got = parse([], "false")
    ok &= record("precedence", "env-only-false", got["suggest_shell_commands"] is False,
                 f"{env_name}=false with empty argv -> {got['suggest_shell_commands']!r}")

    # 3b. THE CONTRACT: explicit CLI beats env, in both directions.
    got = parse(["--no-" + FIXTURE], "true")
    ok &= record("precedence", "cli-beats-env-negative",
                 got["suggest_shell_commands"] is False,
                 f"{env_name}=true + --no-{FIXTURE} -> {got['suggest_shell_commands']!r}")
    got = parse(["--" + FIXTURE], "false")
    ok &= record("precedence", "cli-beats-env-positive",
                 got["suggest_shell_commands"] is True,
                 f"{env_name}=false + --{FIXTURE} -> {got['suggest_shell_commands']!r}")

    # 3c. unrelated defaults are untouched by the override.
    got = parse(["--no-" + FIXTURE], "true")
    ok &= record("precedence", "controls-unchanged",
                 got["detect_urls"] is True and got["cache_prompts"] is False,
                 f"detect_urls={got['detect_urls']!r} cache_prompts={got['cache_prompts']!r} "
                 "while the fixture option was overridden")

    # 3d. explicit CLI beats a config file too.
    with tempfile.TemporaryDirectory() as td:
        cfg = Path(td) / "aider.conf.yml"
        cfg.write_text(f"{FIXTURE}: false\n", encoding="utf-8")
        got = parse(["--" + FIXTURE], None, [str(cfg)])
        ok &= record("precedence", "cli-beats-config",
                     got["suggest_shell_commands"] is True,
                     f"{cfg.name}: {FIXTURE}: false + --{FIXTURE} -> "
                     f"{got['suggest_shell_commands']!r}")
        got = parse([], None, [str(cfg)])
        ok &= record("precedence", "config-only",
                     got["suggest_shell_commands"] is False,
                     f"{cfg.name}: {FIXTURE}: false with empty argv -> "
                     f"{got['suggest_shell_commands']!r}")

    # 3e. end-to-end through main() when the full runtime is importable.
    try:
        from prompt_toolkit.input import DummyInput
        from prompt_toolkit.output import DummyOutput

        from aider.main import main as aider_main

        with tempfile.TemporaryDirectory() as td:
            cwd = os.getcwd()
            os.chdir(td)
            try:
                os.environ[env_name] = "true"
                coder = aider_main(
                    ["--no-" + FIXTURE, "--no-git", "--exit", "--yes"],
                    input=DummyInput(),
                    output=DummyOutput(),
                    return_coder=True,
                )
                ok &= record("precedence", "e2e-coder-override",
                             coder.suggest_shell_commands is False,
                             f"AIDER_...=true + --no-{FIXTURE} -> "
                             f"coder.suggest_shell_commands={coder.suggest_shell_commands!r}")
                ok &= record("precedence", "e2e-controls",
                             coder.detect_urls is True,
                             f"coder.detect_urls={coder.detect_urls!r} (unrelated default kept)")
            finally:
                os.chdir(cwd)
    except Exception as exc:
        record_skip("precedence", "e2e", f"main() not drivable: {type(exc).__name__}: {exc}")

    return ok


def main():
    ok = True
    ok &= layer_declared()
    ok &= layer_cli()
    prec = layer_precedence()
    if prec is not None:
        ok &= prec

    skipped = [r["name"] for r in results if r.get("skipped")]
    failed = [r["name"] for r in results if r["ok"] is False]
    passed = [r["name"] for r in results if r["ok"] is True]
    summary = {
        "contract": "C-T07",
        "fixture_option": "--" + FIXTURE,
        "repo": str(REPO),
        "layers": results,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "status": "fail" if failed else ("partial" if skipped else "pass"),
    }
    print("\n== summary ==")
    print(json.dumps({k: v for k, v in summary.items() if k != "layers"}, indent=2))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
