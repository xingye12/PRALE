"""Miniature code-map helper used by the demo fixture."""

from collections import Counter


def tokenize_symbol(name):
    """Split a snake_case symbol name into its parts."""
    return [part for part in name.split("_") if part]


def render_code_map(files, mentioned_idents=None):
    """Return a ``path:`` listing of the symbols found in ``files``."""
    mentioned_idents = mentioned_idents or set()
    lines = []
    for path, symbols in sorted(files.items()):
        lines.append(f"{path}:")
        for symbol in sorted(symbols):
            marker = "*" if symbol in mentioned_idents else " "
            lines.append(f"{marker} {symbol}")
    return "\n".join(lines)


def count_symbols(files):
    """Count how often each symbol appears across all files."""
    counter = Counter()
    for symbols in files.values():
        counter.update(symbols)
    return counter
