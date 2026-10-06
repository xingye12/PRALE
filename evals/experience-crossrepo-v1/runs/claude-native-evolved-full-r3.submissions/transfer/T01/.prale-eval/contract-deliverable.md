# Contract deliverable — T01 (aider, mode=contract)

## Result / normalized operation

A single focused regression test was added to the existing suite:

- **File:** `tests/basic/test_coder.py`
- **Symbol:** `TestCoder.test_no_auto_commits_disables_dirty_commits`
- **Lines:** 1037–1074 (inclusive)

It is the only production change; nothing else in the repository was modified.

## Behavior under contract

`auto_commits=False` must disable dirty-commit handling, even when `dirty_commits=True`
is explicitly requested.

- `aider/coders/base_coder.py:409-413` — in `Coder.__init__`, a falsy `auto_commits`
  coerces `dirty_commits` to `False` before both attributes are assigned.
- `aider/coders/base_coder.py:2175-2189` — `Coder.check_for_dirty_commit` returns early
  when `self.dirty_commits` is `False`, so a dirty file is never scheduled in
  `need_commit_before_edits`; with dirty commits enabled and `repo.is_dirty(path)` true,
  the path is appended.

## Executable demo (setup / action / assertion)

The test follows the same discipline as the surrounding `TestCoder` methods
(`setUp` builds `Model("gpt-3.5-turbo")` and patches `aider.io.webbrowser.open`;
tests run inside `GitTemporaryDirectory`):

1. **Setup** — create a git repo in a temp dir, commit `file.txt` containing `one\n`,
   then rewrite it to `two\n` so it is dirty; build `InputOutput(yes=True)`.
2. **Action** — `Coder.create(<model>, "diff", io=io, fnames=[...], auto_commits=False,
   dirty_commits=True)` then `coder.check_for_dirty_commit(str(fname))`.
3. **Assertion** —
   - `coder.auto_commits is False` and `coder.dirty_commits is False`
     (the explicit `dirty_commits=True` is overridden);
   - `coder.need_commit_before_edits == set()` (dirty file not scheduled).
   Positive control: a default coder (`auto_commits`/`dirty_commits` on) reports both
   flags `True` and, after the same call, contains the dirty path in
   `need_commit_before_edits`.

Distinctness: `tests/basic/test_coder.py` already covers `suggest_shell_commands`,
`detect_urls`, `chat_language`, and `system_prompt_prefix`, but the
`auto_commits` → `dirty_commits` interaction was untested at the coder level.

## How to run

```bash
python -m pytest tests/basic/test_coder.py -k no_auto_commits_disables_dirty_commits -q
```

## Validation status

- `python -m py_compile tests/basic/test_coder.py` → **exit 0** (module syntactically valid).
- Focused pytest run → **blocked by missing optional dependency**: `GitPython` is not
  installed in this environment, so `tests/basic/test_coder.py` fails collection at
  `import git` (`ModuleNotFoundError: No module named 'git'`). Per task constraints,
  dependencies were not installed; the limitation is recorded here and in
  `.prale-eval/result.json`. The test is expected to pass wherever the existing
  `tests/basic/test_coder.py` tests run.
