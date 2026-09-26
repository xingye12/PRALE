import sqlite3

from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


def test_memory_sqlite_migrates_legacy_archive_and_job_columns(tmp_path) -> None:
    path = tmp_path / "legacy.db"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE trace_archives(
          archive_id TEXT PRIMARY KEY, team_id TEXT, agent_id TEXT, user_id TEXT, session_id TEXT, lane TEXT,
          operation_id TEXT, operation_kind TEXT, base_tip_id TEXT, tip_id TEXT, source_entry_hash TEXT,
          trace_format_version TEXT, created_at INTEGER, content_hash TEXT, parent_archive_id TEXT, parent_gap INTEGER);
        CREATE TABLE memory_jobs(
          job_id TEXT PRIMARY KEY, team_id TEXT, agent_id TEXT, user_id TEXT, stage TEXT, input_high_watermark INTEGER,
          status TEXT, not_before INTEGER, attempt INTEGER, created_at INTEGER, updated_at INTEGER, input_ids TEXT,
          lease_id TEXT, lease_until INTEGER, error_class TEXT, output_hash TEXT);
        """
    )
    connection.execute(
        "INSERT INTO trace_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("archive", "t", "a", "u", "s", "l", "o", "run", None, None, "hash", "conversation-v1", 1, "content", None, 0),
    )
    connection.commit()
    connection.close()

    store = SQLiteMemoryStore(path)
    archive_columns = {row[1] for row in store._conn.execute("PRAGMA table_info(trace_archives)")}  # noqa: SLF001
    job_columns = {row[1] for row in store._conn.execute("PRAGMA table_info(memory_jobs)")}  # noqa: SLF001
    assert {"ancestor_item_ids"}.issubset(archive_columns)
    assert {"prompt_id", "prompt_version", "prompt_mode", "input_hash"}.issubset(job_columns)
    assert store._conn.execute("SELECT archive_id FROM trace_archives").fetchone()[0] == "archive"  # noqa: SLF001
    store.close()
