"""Bash AST admission checks; never execute expansions or infer sandbox safety."""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import tree_sitter_bash
from tree_sitter import Language, Node, Parser

SHELL_GUARD_VERSION = "2"
_SHELLS = {"sh", "bash", "dash", "zsh", "ksh", "ash"}
_DYNAMIC = "shell guard: cannot statically inspect executable or sensitive arguments"


@dataclass(frozen=True)
class _Word:
    value: str | None
    glob: bool = False
    node: Node | None = None
    expanded: bool = False


def _unescape(text: str, *, double: bool = False) -> str:
    result = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            following = text[index + 1]
            if following == "\n":
                index += 2
                continue
            if not double or following in '$`"\\':
                index += 1
                char = following
        result.append(char)
        index += 1
    return "".join(result)


def _ansi_string(text: str) -> str:
    escapes = {
        "a": "\a",
        "b": "\b",
        "e": "\x1b",
        "E": "\x1b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "v": "\v",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "?": "?",
    }

    def decode(match: re.Match[str]) -> str:
        code = match.group()[1:]
        if code in escapes:
            return escapes[code]
        if code.startswith("c") and len(code) == 2:
            return chr(ord(code[1].upper()) ^ 64)
        if code[0] in "xuU" and len(code) > 1:
            number = int(code[1:], 16)
            return chr(number) if number <= 0x10FFFF else "\ufffd"
        if code[0] in "01234567":
            return chr(int(code, 8) % 256)
        return match.group()

    return re.sub(
        r"\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|c.|.)", decode, text, flags=re.DOTALL
    ).split("\0", 1)[0]


def _has_glob(raw: str) -> bool:
    index = 0
    while index < len(raw):
        if raw[index] == "\\":
            index += 2
            continue
        if raw[index] in "*?[":
            return True
        index += 1
    return False


def _word(node: Node, *, double: bool = False) -> _Word:
    raw = node.text.decode("utf-8") if node.text is not None else ""
    kind = node.type
    if kind == "raw_string":
        return _Word(raw[1:-1], node=node)
    if kind == "ansi_c_string":
        return _Word(_ansi_string(raw[2:-1]), node=node)
    if kind in {"simple_expansion", "expansion"}:
        return _Word(str(Path.home()) if raw in {"$HOME", "${HOME}"} else None, node=node, expanded=True)
    if kind in {"command_name", "concatenation", "string"}:
        if kind == "concatenation" and any(
            child.type == "word" and child.text and re.search(rb"(?<!\\)[{}]", child.text)
            for child in node.named_children
        ):
            return _Word(None, node=node)
        pieces = [_word(child, double=double or kind == "string") for child in node.named_children]
        value = None if any(p.value is None for p in pieces) else "".join(p.value or "" for p in pieces)
        return _Word(value, any(p.glob for p in pieces), node, any(p.expanded for p in pieces))
    if kind in {"word", "number", "string_content"}:
        value = _unescape(raw, double=double)
        if not double and raw.startswith("~"):
            value = str(Path(value).expanduser())
        glob = not double and _has_glob(raw)
        return _Word(value, glob, node)
    return _Word(None, node=node)


def _redirects(command: Node) -> list[Node]:
    redirects = list(command.children_by_field_name("redirect"))
    current = command
    parent = current.parent
    while parent is not None:
        if parent.type == "redirected_statement" and parent.child_by_field_name("body") == current:
            redirects.extend(parent.children_by_field_name("redirect"))
        elif parent.type == "pipeline":
            if parent.named_children[-1] != current:
                break  # A trailing pipeline redirect belongs to its last stage.
        elif parent.type not in {"subshell", "compound_statement"}:
            break
        current, parent = parent, parent.parent
    return redirects


def _stdin_redirect(node: Node) -> bool:
    descriptor = node.child_by_field_name("descriptor")
    if descriptor is not None and descriptor.text != b"0":
        return False
    return any(child.type.startswith("<") for child in node.children if not child.is_named)


def _words(command: Node) -> list[_Word]:
    name = command.child_by_field_name("name")
    if name is None:
        return []
    nodes = [name, *command.children_by_field_name("argument")]
    # The Bash grammar places post-redirect arguments in additional destination fields.
    for redirect in _redirects(command):
        if redirect.type == "file_redirect":
            nodes.extend(list(redirect.children_by_field_name("destination"))[1:])
    ordered = sorted(nodes, key=lambda n: n.start_byte)
    result: list[_Word] = []
    # tree-sitter emits separate words across an escaped newline even though Bash
    # removes that continuation before tokenization. Rejoin only that exact gap.
    source_node = command.parent if command.parent is not None else command
    source = source_node.text or b""
    previous: Node | None = None
    for node in ordered:
        word = _word(node)
        gap = (
            source[previous.end_byte - source_node.start_byte : node.start_byte - source_node.start_byte]
            if previous
            else b""
        )
        if previous is not None and gap and not gap.replace(b"\\\n", b""):
            last = result.pop()
            value = None if last.value is None or word.value is None else last.value + word.value
            result.append(_Word(value, last.glob or word.glob, last.node, last.expanded or word.expanded))
        else:
            result.append(word)
        previous = node
    return result


def _unwrap(words: list[_Word]) -> list[_Word]:
    while words and words[0].value is not None:
        name = Path(words[0].value).name
        if name not in {"env", "command", "exec", "nohup", "builtin", "time"}:
            break
        words = words[1:]
        if name == "command" and any(w.value in {"-v", "-V"} for w in words[:1]):
            return []  # A command lookup does not execute the named program.
        while words:
            value = words[0].value
            if value is None:
                break
            if name == "env" and (
                value.startswith("--split-string")
                or (value.startswith("-") and not value.startswith("--") and "S" in value)
            ):
                return [_Word(None)]  # GNU env -S has a separate expansion language.
            if value == "--":
                words = words[1:]
                if name == "env":
                    while words and words[0].value and re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", words[0].value):
                        words = words[1:]
                break
            if name == "env" and re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", value):
                words = words[1:]
                continue
            if not value.startswith("-"):
                break
            # Options that consume the next word must not hide the executable.
            count = (
                2
                if (name == "env" and value in {"-u", "--unset", "-C", "--chdir"})
                or (name == "exec" and value == "-a")
                or (name == "time" and value in {"-f", "--format", "-o", "--output"})
                else 1
            )
            words = words[count:]
    return words


def _critical_path(word: _Word, cwd: Path) -> bool:
    value = word.value
    if not value or value in {"*", "**"}:
        return False
    if word.glob:
        value = value.rstrip("/*") or "/"
    target = Path(value)
    if not target.is_absolute():
        target = cwd / target
    return target.resolve() in {Path("/"), Path.home().resolve()}


def _walk_nodes(node: Node) -> Iterator[Node]:
    pending = [node]
    while pending:
        current = pending.pop()
        yield current
        pending.extend(reversed(current.named_children))


def _stdout_diverted(node: Node) -> bool:
    redirects = _redirects(node)
    for redirect in reversed(redirects):
        if redirect.type != "file_redirect":
            continue
        descriptor = redirect.child_by_field_name("descriptor")
        if descriptor is not None and descriptor.text != b"1":
            continue
        operators = [c.type for c in redirect.children if not c.is_named]
        if not any(op in {">", ">>", ">|", "&>", "&>>"} for op in operators):
            continue
        destinations = redirect.children_by_field_name("destination")
        if destinations:
            value = _word(destinations[0]).value
            return value is not None and value not in {"/dev/stdout", "/proc/self/fd/1"}
    return False


def _contains_download(node: Node, *, include_diverted: bool = False) -> bool:
    for child in _walk_nodes(node):
        if child.type == "command":
            words = _unwrap(_words(child))
            if (
                words
                and words[0].value
                and Path(words[0].value).name in {"curl", "wget"}
                and (include_diverted or not _stdout_diverted(child))
            ):
                return True
    return False


def _shell_mode(args: list[_Word]) -> tuple[_Word | None, bool]:
    """Find literal -c code and whether this invocation reads a stdin script."""
    index = 0
    while index < len(args):
        value = args[index].value
        if value is None:
            return _Word(None), False
        if value == "--":
            index += 1
            break
        if not value.startswith("-") or value == "-":
            break
        if value in {"--rcfile", "--init-file", "-o", "-O"}:
            index += 2
            continue
        if not value.startswith("--"):
            if "c" in value[1:]:
                return args[index + 1] if index + 1 < len(args) else _Word(None), False
            if "s" in value[1:]:
                return None, True
        index += 1
    return None, index == len(args) or args[index].value in {"-", "/dev/stdin", "/proc/self/fd/0"}


@lru_cache(maxsize=1)
def _language() -> Language:
    return Language(tree_sitter_bash.language())


def blocked_shell_reason(command: str, cwd: Path, *, depth: int = 0) -> str | None:
    """Inspect Bash syntax without executing it; reject parse/inspection failures."""
    return _inspect_script(command, cwd, depth, False)


def _inspect_script(command: str, cwd: Path, depth: int, downloaded: bool) -> str | None:
    if depth > 12:
        return "shell guard: nested shell inspection limit exceeded"
    try:
        root = Parser(_language()).parse(command.encode("utf-8")).root_node
        if root.has_error:
            return "shell guard: invalid or unsupported Bash syntax"
        return _Guard(cwd, depth).visit(root, downloaded)
    except (ValueError, RuntimeError, RecursionError, OSError):
        return "shell guard: Bash AST inspection failed"


@dataclass
class _Guard:
    cwd: Path
    depth: int

    def visit(self, node: Node, downloaded: bool = False) -> str | None:
        if node.type == "pipeline":
            for stage in node.named_children:
                reason = self.visit(stage, downloaded)
                if reason:
                    return reason
                following = stage.next_sibling
                downloaded = downloaded or _contains_download(
                    stage, include_diverted=following is not None and following.type == "|&"
                )
                if _stdout_diverted(stage) and (following is None or following.type != "|&"):
                    downloaded = False
            return None
        if node.type == "function_definition":
            name = node.child_by_field_name("name")
            body = node.child_by_field_name("body")
            if name is not None and body is not None:
                function_name = _word(name).value
                for child in _walk_nodes(body):
                    if child.type != "pipeline":
                        continue
                    recursive = 0
                    for stage in child.named_children:
                        if stage.type == "command":
                            words = _unwrap(_words(stage))
                            recursive += bool(words and words[0].value == function_name)
                    if recursive >= 2 and any(c.type == "&" for c in body.children):
                        return "shell guard: fork bomb"
        if node.type == "command":
            reason = self.inspect_command(node, downloaded)
            if reason:
                return reason
        if node.type == "file_redirect":
            reason = self.inspect_redirect(node)
            if reason:
                return reason
        for child in node.named_children:
            reason = self.visit(child, downloaded)
            if reason:
                return reason
        return None

    def inspect_redirect(self, node: Node) -> str | None:
        if not any(">" in child.type for child in node.children if not child.is_named):
            return None
        destinations = node.children_by_field_name("destination")
        if not destinations:
            return None
        value = _word(destinations[0]).value
        if value is None:
            return None  # Executable substitutions are inspected separately.
        target = str((self.cwd / value).resolve())
        if target.startswith("/dev/") and target not in {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"}:
            return "shell guard: raw device write"
        return None

    def inspect_command(self, node: Node, downloaded: bool) -> str | None:
        words = _unwrap(_words(node))
        if not words:
            return None
        executable = words[0].value
        if executable is None or words[0].glob or words[0].expanded:
            return _DYNAMIC
        name, args = Path(executable).name, words[1:]
        values = [arg.value for arg in args]
        category = None
        if name == "sudo":
            category = "privilege escalation"
        elif name == "mkfs" or name.startswith("mkfs."):
            category = "filesystem formatting"
        elif name in {"shutdown", "reboot", "poweroff", "halt", "telinit", "init"}:
            category = "system power or runlevel change"
        elif name == "systemctl" and any(v in {"reboot", "poweroff", "halt", "kexec"} for v in values):
            category = "system power change"
        elif name == "dd":
            if any(v is None for v in values):
                return _DYNAMIC
            if any(v and v.startswith("of=/dev/") for v in values):
                category = "raw device write"
        elif name == "git":
            reason = self.inspect_git(args)
            if reason:
                return reason
        elif name in {"rm", "chmod"}:
            if any(v is None for v in values):
                return _DYNAMIC
            options = values[: values.index("--")] if "--" in values else values
            recursive = any(
                v == "--recursive" or (v and v.startswith("-") and not v.startswith("--") and ("r" in v or "R" in v))
                for v in options
            )
            if recursive and any(
                _critical_path(arg, self.cwd) for arg in args if arg.value and not arg.value.startswith("-")
            ):
                if name == "rm":
                    category = "recursive root or home removal"
                elif any(v in {"777", "0777", "a=rwx", "a+rwx"} for v in values):
                    category = "world-writable root or home permissions"
        elif name in _SHELLS:
            code, stdin = _shell_mode(args)
            if code is not None:
                return self.inspect_code(code, downloaded)
            inputs = [r for r in _redirects(node) if _stdin_redirect(r)]
            if stdin and downloaded and not inputs:
                category = "download piped into shell"
            # Script arguments can also be process substitutions rather than stdin.
            if any(
                arg.node is not None and arg.node.type == "process_substitution" and _contains_download(arg.node)
                for arg in args
            ):
                category = "download piped into shell"
            if stdin and inputs:
                reason = self.inspect_shell_input(inputs[-1])
                if reason:
                    return reason
        elif name == "eval":
            if any(v is None for v in values):
                return _DYNAMIC
            return self.inspect_code(_Word(" ".join(v or "" for v in values)), downloaded)
        return f"shell guard: {category}" if category else None

    def inspect_code(self, word: _Word, downloaded: bool = False) -> str | None:
        if word.value is None or word.expanded:
            return _DYNAMIC
        return _inspect_script(word.value, self.cwd, self.depth + 1, downloaded)

    def inspect_shell_input(self, node: Node) -> str | None:
        if node.type == "herestring_redirect":
            return self.inspect_code(_word(node.named_children[0]))
        if node.type == "heredoc_redirect":
            body = next((c for c in node.named_children if c.type == "heredoc_body"), None)
            if body is not None:
                # Unquoted body expansions happen before the receiving shell parses it.
                if any(c.type != "heredoc_content" for c in body.named_children):
                    return _DYNAMIC
                return self.inspect_code(_Word(body.text.decode() if body.text else ""))
        if node.type == "file_redirect":
            if _contains_download(node):
                return "shell guard: download piped into shell"
            if any(c.type == "process_substitution" for c in node.named_children):
                return _DYNAMIC
        return None

    def inspect_git(self, args: list[_Word]) -> str | None:
        index = 0
        while index < len(args):
            value = args[index].value
            if value is None:
                return _DYNAMIC
            if value in {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}:
                index += 2
                continue
            if value.startswith("-"):
                index += 1
                continue
            break
        if index == len(args) or args[index].value != "push":
            return None
        for arg in args[index + 1 :]:
            value = arg.value
            if value is None:
                return _DYNAMIC
            if value.startswith(("--force", "+")) or (
                value.startswith("-") and not value.startswith("--") and "f" in value
            ):
                return "shell guard: forced Git push"
        return None
