"""Entry point that ranks and renders the miniature code-map."""

from src.codemap import count_symbols, render_code_map, tokenize_symbol


def main(files):
    summary = count_symbols(files)
    for ident in list(summary):
        tokenize_symbol(ident)
    return render_code_map(files, mentioned_idents=set(summary))
