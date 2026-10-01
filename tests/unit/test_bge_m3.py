import asyncio

import pytest

from agent_harness.integrations.bge_m3 import LocalBgeM3EmbeddingProvider


class _Model:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], bool, bool]] = []

    def encode(self, texts: list[str], *, normalize_embeddings: bool, show_progress_bar: bool) -> list[list[float]]:
        self.calls.append((texts, normalize_embeddings, show_progress_bar))
        return [[float(index + 1), 0.0] for index, _ in enumerate(texts)]


def test_local_bge_m3_provider_loads_lazily_and_normalizes_dense_vectors(tmp_path) -> None:
    (tmp_path / "config.json").write_text("{}")
    model = _Model()
    loaded: list[str] = []
    provider = LocalBgeM3EmbeddingProvider(tmp_path, loader=lambda path: loaded.append(path) or model)

    assert loaded == []
    assert provider.model_id.startswith("bge-m3:")
    assert asyncio.run(provider.embed(("first", "second"))) == ((1.0, 0.0), (2.0, 0.0))
    assert loaded == [str(tmp_path.resolve())]
    assert model.calls == [(["first", "second"], True, False)]


def test_local_bge_m3_provider_refuses_a_non_model_directory(tmp_path) -> None:
    with pytest.raises(ValueError, match="model directory"):
        LocalBgeM3EmbeddingProvider(tmp_path, loader=lambda _: _Model())
