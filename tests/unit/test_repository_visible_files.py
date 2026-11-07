from rescore_repository_visible_files import bash_visible, read_visible

SOURCES = {
    "src/a.py": "def long_function_name():\n    return 123456789\n",
    "src/b.py": "class AnotherClassName:\n    pass\n",
}


def test_filename_lists_and_unreturned_scans_are_not_reads() -> None:
    assert bash_visible("grep -rl function src", "src/a.py\n", SOURCES)[0] == set()
    assert bash_visible("find src -type f", "src/a.py\nsrc/b.py", SOURCES)[0] == set()
    assert bash_visible("ls src", "a.py\nb.py", SOURCES)[0] == set()


def test_source_content_and_prefixed_search_matches_are_attributed() -> None:
    assert bash_visible("cat src/a.py", SOURCES["src/a.py"], SOURCES)[0] == {"src/a.py"}
    assert bash_visible("grep -rn function src", "src/a.py:1:def long_function_name():", SOURCES)[0] == {"src/a.py"}
    assert bash_visible("cat src/a.py src/b.py | head -2", SOURCES["src/a.py"], SOURCES)[0] == {"src/a.py"}


def test_explorer_cannot_contribute_and_failed_reads_are_excluded() -> None:
    event = {
        "name": "read",
        "outcome": "completed",
        "is_error": False,
        "input": {"path": "src/a.py"},
        "output": {"content": "actual code"},
    }
    assert read_visible(event) == {"src/a.py"}
    assert read_visible({**event, "name": "repository_explore"}) == set()
    assert read_visible({**event, "is_error": True}) == set()
    assert (
        read_visible({**event, "output": {"content": "limit", "details": {"truncation": {"output_lines": 0}}}}) == set()
    )
