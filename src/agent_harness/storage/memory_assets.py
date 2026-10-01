"""File-authoritative L2/L3 assets.

The payload lives in Markdown.  SQLite stores only pipeline state; the index is
derived metadata and can always be recreated from scene files.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from agent_harness.domain.memory import (
    GLOBAL_L3_SCOPE,
    MemoryScope,
    OperatingDoctrine,
    PromotionConflict,
    WorkSceneMemory,
    content_hash,
)


class MarkdownMemoryAssets:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _scope_key(self, scope: MemoryScope) -> str:
        return hashlib.sha256(scope.repository_id.encode()).hexdigest()

    def _scope_dir(self, scope: MemoryScope) -> Path:
        return self.root / "scopes" / self._scope_key(scope)

    def _scene_path(self, scope: MemoryScope, scene_id: str) -> Path:
        return self._scope_dir(scope) / "l2" / "scenes" / f"{scene_id}.md"

    def _index_path(self, scope: MemoryScope) -> Path:
        return self._scope_dir(scope) / "l2" / "index.json"

    def _doctrine_path(self) -> Path:
        return self.root / "l3" / "operating-doctrine.md"

    def _scene_history_path(self, scene: WorkSceneMemory) -> Path:
        return self._scope_dir(scene.scope) / "l2" / "history" / scene.scene_id / f"v{scene.version:04d}.md"

    def _doctrine_history_path(self, doctrine: OperatingDoctrine) -> Path:
        return self.root / "l3" / "history" / f"v{doctrine.version:04d}.md"

    def read_scenes(self, scope: MemoryScope) -> tuple[WorkSceneMemory, ...]:
        result: list[WorkSceneMemory] = []
        entries = self._index(scope).get("scenes", [])
        if not entries:
            return tuple(self._scene_files(scope))
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            scene = self._read_scene(scope, str(entry.get("scene_id", "")))
            if scene is not None:
                result.append(scene)
        return tuple(result)

    def write_scene(self, scene: WorkSceneMemory, expected_hash: str | None = None) -> None:
        self._replace(
            self._scope_dir(scene.scope) / "scope.json", json.dumps({"repository_id": scene.scope.repository_id}) + "\n"
        )
        meta = _scene_meta(scene)
        document = _document(meta, scene.content)
        previous = self._read_scene(scene.scope, scene.scene_id)
        if (previous.content_hash if previous is not None else None) != expected_hash:
            raise PromotionConflict("scene file changed before replacement")
        if previous is not None and previous.content_hash != scene.content_hash:
            self._replace(self._scene_history_path(previous), _document(_scene_meta(previous), previous.content))
        self._replace(self._scene_path(scene.scope, scene.scene_id), document)
        scenes = {item.scene_id: item for item in self._scene_files(scene.scope)}
        scenes[scene.scene_id] = scene
        self._write_index(scene.scope, scenes.values())

    def write_doctrine(self, doctrine: OperatingDoctrine, expected_hash: str | None = None) -> None:
        meta = {
            "kind": "prale-l3",
            "version": doctrine.version,
            "l2_ids": list(doctrine.l2_ids),
            "l2_high_watermark": doctrine.l2_high_watermark,
            "created_at": doctrine.created_at,
            "updated_at": doctrine.updated_at,
            "content_hash": doctrine.content_hash,
        }
        previous = self.read_doctrine()
        if (previous.content_hash if previous is not None else None) != expected_hash:
            raise PromotionConflict("doctrine file changed before replacement")
        if previous is not None and previous.content_hash != doctrine.content_hash:
            self._replace(self._doctrine_history_path(previous), _document(_doctrine_meta(previous), previous.content))
        self._replace(self._doctrine_path(), _document(meta, doctrine.content))

    def read_doctrine(self) -> OperatingDoctrine | None:
        parsed = _parse(self._doctrine_path())
        if parsed is None:
            return None
        meta, body = parsed
        return OperatingDoctrine(
            "global-doctrine",
            GLOBAL_L3_SCOPE,
            int(meta["version"]),
            body,
            tuple(meta.get("l2_ids", [])),
            int(meta.get("l2_high_watermark", 0)),
            int(meta["created_at"]),
            int(meta["updated_at"]),
            str(meta["content_hash"]),
        )

    def index_json(self, scope: MemoryScope) -> str:
        path = self._index_path(scope)
        return path.read_text(encoding="utf-8") if path.exists() else '{"scenes": []}\n'

    def read_scene(self, scope: MemoryScope, scene_id: str) -> WorkSceneMemory | None:
        known = {
            str(entry.get("scene_id", "")) for entry in self._index(scope).get("scenes", []) if isinstance(entry, dict)
        }
        if scene_id not in known:
            return None
        return self._read_scene(scope, scene_id)

    def rebuild_index(self, scope: MemoryScope) -> int:
        scenes = self._scene_files(scope)
        self._write_index(scope, scenes)
        return len(scenes)

    def delete_scope(self, scope: MemoryScope) -> None:
        """Remove only this scope's assets; callers must have completed their DB intent."""
        directory = self._scope_dir(scope)
        if not directory.exists():
            return
        import shutil

        shutil.rmtree(directory)

    def delete_scene(self, scope: MemoryScope, scene_id: str) -> bool:
        path = self._scene_path(scope, scene_id)
        if not path.exists():
            return False
        path.unlink()
        self.rebuild_index(scope)
        return True

    def _read_scene(self, scope: MemoryScope, scene_id: str) -> WorkSceneMemory | None:
        parsed = _parse(self._scene_path(scope, scene_id))
        if parsed is None:
            return None
        meta, body = parsed
        if meta.get("repository_id") != scope.repository_id or meta.get("scene_id") != scene_id:
            return None
        return WorkSceneMemory(
            scene_id,
            scope,
            str(meta["scenario_key"]),
            int(meta["version"]),
            str(meta["status"]),
            body,
            str(meta.get("summary", "")),
            float(meta.get("heat", 0)),
            tuple(meta.get("l1_ids", [])),
            int(meta.get("l1_high_watermark", 0)),
            int(meta["created_at"]),
            int(meta["updated_at"]),
            str(meta["content_hash"]),
            bool(meta.get("persona_update_request", False)),
        )

    def _scene_files(self, scope: MemoryScope) -> list[WorkSceneMemory]:
        directory = self._scope_dir(scope) / "l2" / "scenes"
        if not directory.exists():
            return []
        return [scene for path in directory.glob("*.md") if (scene := self._read_scene(scope, path.stem)) is not None]

    def _index(self, scope: MemoryScope) -> dict[str, object]:
        try:
            value = json.loads(self._index_path(scope).read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {"scenes": []}
        except (OSError, json.JSONDecodeError):
            return {"scenes": []}

    def _write_index(self, scope: MemoryScope, scenes: object) -> None:
        items = sorted(
            (_index_entry(scene) for scene in scenes), key=lambda item: (item["heat"], item["updated_at"]), reverse=True
        )
        self._replace(
            self._index_path(scope),
            json.dumps(
                {"format_version": 1, "repository_id": scope.repository_id, "scenes": items},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )

    @staticmethod
    def _replace(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)


def _document(meta: dict[str, object], body: str) -> str:
    return f"---\n{json.dumps(meta, ensure_ascii=False, sort_keys=True)}\n---\n{body}"


def _parse(path: Path) -> tuple[dict[str, object], str] | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not raw.startswith("---\n"):
        return None
    encoded, body = raw[4:].split("\n---\n", 1)
    try:
        value = json.loads(encoded)
        return (value, body) if isinstance(value, dict) and content_hash(body) == value.get("content_hash") else None
    except (ValueError, json.JSONDecodeError):
        return None


def _scene_meta(scene: WorkSceneMemory) -> dict[str, object]:
    return {
        "kind": "prale-l2",
        "scene_id": scene.scene_id,
        "repository_id": scene.scope.repository_id,
        "scenario_key": scene.scenario_key,
        "version": scene.version,
        "status": scene.status,
        "summary": scene.summary,
        "heat": scene.heat,
        "l1_ids": list(scene.l1_ids),
        "l1_high_watermark": scene.l1_high_watermark,
        "created_at": scene.created_at,
        "updated_at": scene.updated_at,
        "content_hash": scene.content_hash,
        "persona_update_request": scene.persona_update_request,
    }


def _doctrine_meta(doctrine: OperatingDoctrine) -> dict[str, object]:
    return {
        "kind": "prale-l3",
        "version": doctrine.version,
        "l2_ids": list(doctrine.l2_ids),
        "l2_high_watermark": doctrine.l2_high_watermark,
        "created_at": doctrine.created_at,
        "updated_at": doctrine.updated_at,
        "content_hash": doctrine.content_hash,
    }


def _index_entry(scene: WorkSceneMemory) -> dict[str, object]:
    return {
        key: value
        for key, value in _scene_meta(scene).items()
        if key not in {"l1_ids", "l1_high_watermark", "persona_update_request"}
    }
