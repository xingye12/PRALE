# Contract deliverable — T19 (repository: `aider`, mode: `contract`)

## Request

Evaluate in aider: add a focused test for a distinct command/config behavior using the same
setup/action/assertion discipline.

## What was delivered

A single, minimal, non-invasive addition to `tests/basic/test_coder.py`:

- New test method: `TestCoder.test_cmd_test_uses_configured_test_cmd` (inclusive lines **1436–1466**).

No production code, task metadata, hidden-oracle files, package locks, or git configuration were
touched. The only file modified is `tests/basic/test_coder.py`.

## Distinct command/config behavior under test

The `/test` command (`aider/commands.py:Commands.cmd_test`) falls back to the configured
`test_cmd` (`aider/coders/base_coder.py:Coder.__init__` stores it as `self.test_cmd`) when it is
dispatched with **no argument**, and it only surfaces output when the configured callable reports
an error. Nothing in `tests/basic/test_coder.py` covered `/test` or `test_cmd` before.

## Setup / action / assertion discipline (same as existing tests)

| Step | New test | Existing precedent in the same file |
| --- | --- | --- |
| Setup | `with GitTemporaryDirectory():` + `InputOutput(yes=True)` + `Coder.create(self.GPT35, "diff", io=io, test_cmd=<callable>)` | `test_detect_urls_disabled` (1024–1035), `test_no_suggest_shell_commands` (1006–1010) |
| Action | `coder.commands.run("/test")` (no argument) | `coder.check_for_urls(message)` |
| Assertion | `test_cmd.assert_called_once()`, `io.tool_output.assert_called_once_with(failure_output)`, `assertEqual(result, failure_output)`; success path: `io.tool_output.assert_not_called()`, `assertIsNone(result)` | `scraper.scrape.assert_not_called()`, `assertFalse(coder.suggest_shell_commands)` |

## Executable demo

```python
# tests/basic/test_coder.py, class TestCoder
def test_cmd_test_uses_configured_test_cmd(self):
    with GitTemporaryDirectory():
        io = InputOutput(yes=True)
        io.tool_output = MagicMock()

        failure_output = "1 failed, 0 passed"
        test_cmd = MagicMock(return_value=failure_output)
        coder = Coder.create(self.GPT35, "diff", io=io, test_cmd=test_cmd)

        result = coder.commands.run("/test")          # action: dispatch /test with no args
        test_cmd.assert_called_once()                  # falls back to configured test_cmd
        io.tool_output.assert_called_once_with(failure_output)
        self.assertEqual(result, failure_output)

        io.tool_output.reset_mock()
        passing_test_cmd = MagicMock(return_value=None)
        coder = Coder.create(self.GPT35, "diff", io=io, test_cmd=passing_test_cmd)

        result = coder.commands.run("/test")
        passing_test_cmd.assert_called_once()
        io.tool_output.assert_not_called()             # clean run stays silent
        self.assertIsNone(result)
```

### Observable contract (normalized operation result)

| # | Operation | Expected normalized result |
| --- | --- | --- |
| 1 | Dispatch `/test` with empty args and a failing callable `test_cmd` | callable invoked exactly once; `io.tool_output` called once with the failure string; command return value `== failure string` |
| 2 | Dispatch `/test` with empty args and a passing callable `test_cmd` | callable invoked exactly once; `io.tool_output` never called; command return value `is None` |

## Validation

- Focused command attempted:
  `python -m pytest tests/basic/test_coder.py -k test_cmd_test_uses_configured_test_cmd -q`
  → **blocked**: the sandbox lacks the project's runtime dependencies, so pytest aborts during
  collection with `ModuleNotFoundError: No module named 'git'` (also missing: `json5`, `pexpect`,
  `psutil`, `babel`, `diskcache`). Per policy, no dependencies were installed.
- Substitute static validation (all passed):
  - `python -m py_compile tests/basic/test_coder.py` → `py_compile OK`.
  - `ast.parse` confirmed the new symbol `TestCoder.test_cmd_test_uses_configured_test_cmd` spans
    1436–1466 and `TestCoder.setUp` spans 20–23.
  - `ast.parse` confirmed the cited symbols `Commands.cmd_test` (993–1011), `Commands.run`
    (312–332), `Coder.create` (125–201), `Coder.__init__` (299–542) fall inside the reported ranges.
  - Static trace of `Commands.cmd_test`: empty `args` → `self.coder.test_cmd`; callable → `errors = args()`;
    falsy → silent return; truthy → `io.tool_output(errors)` and `return errors` — matching the assertions.
