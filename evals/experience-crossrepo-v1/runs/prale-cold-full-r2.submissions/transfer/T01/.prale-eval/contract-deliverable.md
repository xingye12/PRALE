# Contract deliverable — T01 (aider, mode: contract)

## Requested behavior

"Add a focused test for a distinct command/config behavior using the same
setup/action/assertion discipline" (aider, `tests/basic/test_coder.py`).

## What was added (executable demo)

Two focused `unittest` methods were appended inside the existing
`TestCoder` class in `tests/basic/test_coder.py`, immediately after the
neighbouring config tests (`test_detect_urls_disabled`) and before
`test_unknown_edit_format_exception`. They cover the previously untested
`--copy-paste` config gate (`auto_copy_context`) and the `/copy-context`
command (`Commands.cmd_copy_context`), a distinct command/config behavior.

```
tests/basic/test_coder.py
  TestCoder.setUp                                              (lines 20-23)
  TestCoder.test_copy_context_respects_auto_copy_context_config (1037-1057)  NEW
  TestCoder.test_cmd_copy_context_copies_chat_files_and_instructions (1059-1077)  NEW
```

### 1. `test_copy_context_respects_auto_copy_context_config` (1037-1057)

* **Setup** — `GitTemporaryDirectory()` + `InputOutput(yes=True)`, then
  `Coder.create(self.GPT35, "diff", io=io)` (default config) and, separately,
  `Coder.create(..., auto_copy_context=True)` (the `--copy-paste` config).
  `coder.commands` is replaced with a `MagicMock`.
* **Action** — `coder.copy_context()` in both states.
* **Assertion** — `assertFalse(coder.auto_copy_context)` and
  `coder.commands.cmd_copy_context.assert_not_called()` for the default;
  `assertTrue(coder.auto_copy_context)` and
  `coder.commands.cmd_copy_context.assert_called_once_with()` when enabled.

This mirrors the file's existing discipline (`setUp` builds
`Model("gpt-3.5-turbo")`; a coder is created with `Coder.create(...)`;
behavior is asserted through mocks), e.g. `test_no_suggest_shell_commands`
and `test_detect_urls_disabled`.

### 2. `test_cmd_copy_context_copies_chat_files_and_instructions` (1059-1077)

* **Setup** — a temp file `example.py` containing `print('copy context marker')`
  is put in the chat via `Coder.create(..., fnames=[fname])`;
  `pyperclip.copy` is patched.
* **Action** — `coder.commands.cmd_copy_context("extra instructions")`.
* **Assertion** — `mock_copy.assert_called_once()`; the copied markdown
  contains the in-chat file content, the
  `Just tell me how to edit the files` instruction footer, and the
  `extra instructions` command argument.

## Contract / normalized operation result

| Item | Value |
| --- | --- |
| Task id | `T01` |
| Repository | `aider` |
| Mode | `contract` |
| Changed file | `tests/basic/test_coder.py` (only this file) |
| Public-API surface touched | none (test-only; no production code, no task metadata, no lockfiles, no git config) |
| Test symbols | `TestCoder.test_copy_context_respects_auto_copy_context_config`, `TestCoder.test_cmd_copy_context_copies_chat_files_and_instructions` |
| Production behavior exercised | `Coder.auto_copy_context` gate in `Coder.copy_context` (`aider/coders/base_coder.py` 894-896) and `Commands.cmd_copy_context` (`aider/commands.py` 1638-1680) |
| Focused run command | `python -m pytest tests/basic/test_coder.py -k copy_context -q` |

## Validation

See `result.json` → `validation`.

* `python -m pytest tests/basic/test_coder.py -k copy_context -q` →
  **blocked**: the sandbox Python environment is missing this repository's
  optional runtime/test dependencies (collection stops at
  `tests/basic/test_coder.py:7: import git` → `ModuleNotFoundError: No module
  named 'git'`; `oslex`, `json5` and `pyperclip` are missing too). Dependencies
  must not be installed by this task, so the limitation is recorded here and
  the failing command output is kept verbatim in `result.json`.
* `python -m py_compile tests/basic/test_coder.py` → **pass** (file compiles;
  no line exceeds the repo's flake8 `max-line-length = 100`).
* `python -m ruff check tests/basic/test_coder.py` → **pass**
  (`All checks passed!`), `ruff format --line-length 100 --diff` →
  `1 file already formatted`.
* AST verification of the added tests (names present, assertion calls found)
  → **pass**: config-gate test asserts
  `assertFalse/assert_not_called/assertTrue/assert_called_once_with`;
  command test asserts `assert_called_once/assertIn x3`.
* Fallback harness `python .prale-eval/validate_copy_context.py` → **pass**.
  Because the real suite cannot be collected, this harness extracts the
  *actual* upstream method bodies (`Coder.copy_context`,
  `Commands.cmd_copy_context`) with `ast` and executes them against stubs,
  reproducing exactly the two assertions above without importing the missing
  dependencies:
  `PASS config gate: auto_copy_context off -> no-op, on -> cmd_copy_context called`
  and `PASS command: user chunks + instructions + args copied, assistant skipped`.

Note: the oracle environment is expected to run the same tests with the
project's real dependencies installed; nothing in the added tests depends on
the fallback harness.
