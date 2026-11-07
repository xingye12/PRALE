"""Validate answer-key evidence against its historical source, not today's files."""

import json
import subprocess
from pathlib import Path, PurePosixPath

from build_repository_explore_datasets import _item

ROOT = Path(__file__).resolve().parents[2]
SOURCE = json.loads((ROOT / "evals/repository_explore/tasks.json").read_text(encoding="utf-8"))


def test_annotations_have_unique_paths_and_real_pinned_evidence() -> None:
    sha = SOURCE["pinned_git_sha"]
    assert SOURCE["file_annotation_policy"]["verified_git_sha"] == sha
    bodies: dict[str, str] = {}
    for task in SOURCE["tasks"]:
        paths = [row["path"] for row in task["relevant_files"]]
        assert len(paths) == len(set(paths)), task["id"]
        for row in task["relevant_files"]:
            path = row["path"]
            assert not PurePosixPath(path).is_absolute() and ".." not in PurePosixPath(path).parts
            assert str(PurePosixPath(path)) == path
            assert type(row["weight"]) is int and row["weight"] in (1, 2, 3)
            assert row["reason"].strip() and row["anchors"]
            if path not in bodies:
                bodies[path] = subprocess.check_output(
                    ["git", "show", f"{sha}:{path}"], cwd=ROOT, text=True, encoding="utf-8"
                )
            for anchor in row["anchors"]:
                assert anchor and anchor in bodies[path], (task["id"], path, anchor)


def test_dataset_builder_keeps_revised_labels_out_of_model_inputs() -> None:
    for task in SOURCE["tasks"]:
        for condition, tools in (("baseline", ["read"]), ("with-explorer", ["read", "repository_explore"])):
            item = _item(
                task,
                condition=condition,
                sha=SOURCE["pinned_git_sha"],
                tools=tools,
                required=SOURCE["global_output_contract"]["required_fields"],
            )
            revised = dict(task, relevant_files=[{"path": "ANSWER_KEY_ONLY_SENTINEL", "weight": 3}])
            assert item == _item(
                revised,
                condition=condition,
                sha=SOURCE["pinned_git_sha"],
                tools=tools,
                required=SOURCE["global_output_contract"]["required_fields"],
            )
            assert set(item["input"]) == {"prompt", "repository_snapshot", "tools"}
