"""Fallback validation harness for the new /copy-context tests.

Limitation: the repository's own test suite cannot be collected in this
sandbox because several runtime/test dependencies are not installed
(GitPython, oslex, json5, pyperclip, ...), and dependencies must not be
installed by this task.  Instead of re-implementing behavior, this harness
extracts the *actual* method bodies from the repository sources and executes
them against lightweight stubs, so the exercised code paths are the
repository's real code:

  * aider/coders/base_coder.py :: Coder.copy_context  (config gate)
  * aider/commands.py         :: Commands.cmd_copy_context (command output)

Run with:  python .prale-eval/validate_copy_context.py
"""

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def extract_method(rel_path, class_name, method_name):
    src = (ROOT / rel_path).read_text()
    tree = ast.parse(src)
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
    fn = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == method_name)
    lines = src.splitlines(keepends=True)
    body = lines[fn.lineno - 1 : fn.end_lineno]
    # Strip the method indentation manually: textwrap.dedent() would be defeated
    # by the column-0 lines inside cmd_copy_context's markdown f-string.
    return "".join(
        line[fn.col_offset :] if line[: fn.col_offset].strip() == "" else line for line in body
    )


def check_config_gate():
    src = extract_method("aider/coders/base_coder.py", "Coder", "copy_context")
    ns = {}
    exec(src, ns)
    copy_context = ns["copy_context"]

    class CommandsStub:
        def __init__(self):
            self.calls = 0

        def cmd_copy_context(self):
            self.calls += 1

    class CoderStub:
        pass

    CoderStub.copy_context = copy_context

    # Default config (--copy-paste not passed) -> no-op.
    coder = CoderStub()
    coder.auto_copy_context = False
    coder.commands = CommandsStub()
    coder.copy_context()
    assert coder.commands.calls == 0, "copy_context must be a no-op when disabled"

    # Enabled config (--copy-paste) -> command invoked exactly once.
    coder = CoderStub()
    coder.auto_copy_context = True
    coder.commands = CommandsStub()
    coder.copy_context()
    assert coder.commands.calls == 1, "copy_context must invoke cmd_copy_context when enabled"

    print("PASS config gate: auto_copy_context off -> no-op, on -> cmd_copy_context called")


def check_command_output():
    src = extract_method("aider/commands.py", "Commands", "cmd_copy_context")
    assert "pyperclip.copy(markdown)" in src, "harness out of sync with upstream command"
    assert "Just tell me how to edit the files" in src

    class _PyperclipException(Exception):
        pass

    class PyperclipStub:
        PyperclipException = _PyperclipException

        def __init__(self):
            self.copied = None

        def copy(self, text):
            self.copied = text

    ns = {"pyperclip": PyperclipStub()}
    exec(src, ns)
    cmd_copy_context = ns["cmd_copy_context"]

    class ChunksStub:
        pass

    class CoderStub:
        def format_chat_chunks(self):
            chunks = ChunksStub()
            chunks.repo = []
            chunks.readonly_files = []
            chunks.chat_files = [
                {
                    "role": "user",
                    "content": "example.py\n```\nprint('copy context marker')\n```",
                },
                {"role": "assistant", "content": "Ok, I see it."},
            ]
            return chunks

    class IOStub:
        def __init__(self):
            self.outputs = []
            self.errors = []

        def tool_output(self, *args, **kwargs):
            self.outputs.append(" ".join(str(a) for a in args))

        def tool_error(self, *args, **kwargs):
            self.errors.append(" ".join(str(a) for a in args))

    class CommandsStub:
        pass

    CommandsStub.cmd_copy_context = cmd_copy_context

    commands = CommandsStub()
    commands.coder = CoderStub()
    commands.io = IOStub()
    commands.cmd_copy_context("extra instructions")

    copied = ns["pyperclip"].copied
    assert copied is not None, "pyperclip.copy was not called"
    assert "copy context marker" in copied, "user chat-file content missing from copied context"
    assert "Just tell me how to edit the files" in copied, "edit instructions missing"
    assert "extra instructions" in copied, "command args missing"
    assert "Ok, I see it." not in copied, "assistant messages must not be copied"
    assert any("Copied code context to clipboard." in o for o in commands.io.outputs)

    print("PASS command: user chunks + instructions + args copied, assistant skipped")


if __name__ == "__main__":
    check_config_gate()
    check_command_output()
    print("ALL FALLBACK CHECKS PASSED")
