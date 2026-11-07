"""Explicitly resume a memory stage, including its blocked dead-letter batch.

The deployment worker performs extraction. This command neither starts a second
worker nor deletes history. Use the same DB, assets and repository as deployment.
"""

import argparse
import asyncio
from pathlib import Path

from agent_harness.domain.memory import MemoryScope
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--stage", choices=("l1", "l2", "l3"), default="l1")
    args = parser.parse_args()
    if not args.db.is_file() or not args.assets.is_dir():
        parser.error("--db and --assets must point to the existing deployment stores")

    async def flush() -> None:
        store = SQLiteMemoryStore(args.db, assets_dir=args.assets)
        try:
            await MemoryRuntime(store).flush(MemoryScope(args.repository), args.stage)
        finally:
            store.close()

    asyncio.run(flush())
    print(f"Flushed {args.stage} for {args.repository}; the deployment worker will process the queued task.")


if __name__ == "__main__":
    main()
