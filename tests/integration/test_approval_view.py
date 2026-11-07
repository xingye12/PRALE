"""Run the shipped JavaScript view's approval interactions without a bundler."""

import shutil
import subprocess
from pathlib import Path

import pytest


def test_approval_view_interactions():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required to execute JavaScript view tests")
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [node, "tests/web/approvals.test.mjs"], cwd=root, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stderr
    assert "approval view interactions passed" in result.stdout
