"""Local BGE-M3 dense embeddings for the optional memory side index.

The model is loaded only when the memory store first needs an embedding.  This
keeps the core harness free of ML dependencies and prevents a large local model
from delaying deployments that have memory enabled but no promoted L1 records.
"""

import asyncio
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from typing import Any


class LocalBgeM3EmbeddingProvider:
    """``EmbeddingProvider`` implementation backed by a local SentenceTransformer.

    BGE-M3's dense vectors are L2-normalized before being persisted.  SQLite
    performs cosine scoring over those vectors; keyword BM25 remains a separate
    signal and the store combines the two with reciprocal-rank fusion.
    """

    def __init__(self, model_path: str | Path, *, loader: Callable[[str], Any] | None = None) -> None:
        path = Path(model_path).expanduser()
        if not path.is_dir() or not (path / "config.json").is_file():
            raise ValueError(f"BGE-M3 model directory is invalid: {path}")
        self._path = path.resolve()
        self._loader = loader
        if loader is None:
            try:
                from sentence_transformers import SentenceTransformer  # noqa: F401
            except ImportError as error:
                raise RuntimeError(
                    "PRALE_MEMORY_EMBEDDING_MODEL requires the embedding extra: "
                    "pip install 'prale-agent-harness[embedding]'"
                ) from error
        digest = sha256((self._path / "config.json").read_bytes()).hexdigest()[:16]
        self._model_id = f"bge-m3:{digest}"
        self._model: Any | None = None
        self._lock = asyncio.Lock()

    @property
    def model_id(self) -> str:
        return self._model_id

    async def embed(self, texts: tuple[str, ...]) -> tuple[tuple[float, ...], ...]:
        if not texts:
            return ()
        async with self._lock:
            return await asyncio.to_thread(self._embed_sync, texts)

    def _embed_sync(self, texts: tuple[str, ...]) -> tuple[tuple[float, ...], ...]:
        if self._model is None:
            self._model = self._load_model()
        vectors = self._model.encode(list(texts), normalize_embeddings=True, show_progress_bar=False)
        if hasattr(vectors, "tolist"):
            vectors = vectors.tolist()
        result = tuple(tuple(float(value) for value in vector) for vector in vectors)
        if len(result) != len(texts) or any(not vector for vector in result):
            raise ValueError("BGE-M3 returned an invalid embedding batch")
        return result

    def _load_model(self) -> Any:
        if self._loader is not None:
            return self._loader(str(self._path))
        from sentence_transformers import SentenceTransformer

        return SentenceTransformer(str(self._path), local_files_only=True)
