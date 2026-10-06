# Contract deliverable — `aider` / T01 / mode: contract

## What was delivered

A focused, executable test for a **distinct command/config behavior** of the aider
coder, added to the public acceptance-contract file `tests/basic/test_coder.py`:

- **Symbol:** `TestCoder.test_auto_commits_disabled_no_commit`
- **Location:** `tests/basic/test_coder.py:612-663`
- **Config behavior under test:** the coder flag `auto_commits=False` (previously
  exercised only at the argparse-plumbing level in `tests/basic/test_main.py`, never
  at the coder behavior level).

No production code, task metadata, hidden-oracle file, package lock, or git
configuration was modified. The only source change is the added test method.

## The contract being demonstrated

Two related, observable guarantees of `aider/coders/base_coder.py`:

1. **Config derivation** — `Coder.__init__` (lines 409-413) forces
   `dirty_commits = False` whenever `auto_commits` is falsy:

   ```python
   if not auto_commits:
       dirty_commits = False
   self.auto_commits = auto_commits
   self.dirty_commits = dirty_commits
   ```

2. **Runtime short-circuit** — `Coder.auto_commit` (lines 2375-2377) returns
   immediately when `auto_commits` is off:

   ```python
   if not self.repo or not self.auto_commits or self.dry_run:
       return
   ```

   `repo.commit()` is the only caller of `repo.get_commit_message()`, so this
   guard also means no commit message is ever generated.

Net contract: **with `auto_commits=False`, a mocked GPT edit is written to disk,
but neither the dirty pre-commit nor the GPT-edit commit is created.**

## Executable demo (the test)

The test follows the exact setup/action/assertion discipline used by the
surrounding commit-behavior tests (e.g. `test_new_file_edit_one_commit`,
`tests/basic/test_coder.py:570-610`):

| Phase | Action |
| --- | --- |
| **Setup** | `GitTemporaryDirectory()` → `git.Repo()` → commit `file.txt` containing `one\n`, then leave it dirty as `two\n` → `InputOutput(yes=True)` → `Coder.create(self.GPT35, "diff", io=io, fnames=["file.txt"], **auto_commits=False**)`. |
| **Action** | Replace `coder.send` with a `mock_send` closure that injects a `SEARCH/REPLACE` diff turning `two` into `three`; mock `coder.repo.get_commit_message`; call `coder.run(with_message="hi")`. |
| **Assertion** | `coder.auto_commits is False`; `coder.dirty_commits is False`; `coder.need_commit_before_edits` is empty; `file.txt` reads `three\n` (edit landed); `len(list(repo.iter_commits(repo.active_branch.name))) == 1` (no commit); `get_commit_message.assert_not_called()`. |

Normalized operation result: **edit applied on disk, repository commit count
unchanged, commit-message generator not invoked.**

## Validation

- **Command attempted:**
  `python3 -m pytest tests/basic/test_coder.py::TestCoder::test_auto_commits_disabled_no_commit -p no:cacheprovider`
- **Status:** blocked — dependency unavailable. Collection fails at module import:
  `ModuleNotFoundError: No module named 'git'` (`tests/basic/test_coder.py:7`, `import git`).
  GitPython is absent from the active interpreter and from `/usr/bin/python3`;
  installing dependencies is out of scope per task constraints, so the test could
  not be executed.
- **Dependency-free validation actually performed:**
  1. `python3 -m py_compile tests/basic/test_coder.py` → `PY_COMPILE_OK`.
  2. AST inspection confirmed `test_auto_commits_disabled_no_commit` is a method of
     class `TestCoder` at lines 612-663, containing a `with GitTemporaryDirectory():`
     block, `Coder.create(... auto_commits=False)`, `coder.run(...)`, and
     `assertFalse` / `assertEqual` / `assert_not_called` calls.
  3. Citation line ranges re-verified against the source files.

No dependencies were installed and nothing outside the workspace was read or written.
