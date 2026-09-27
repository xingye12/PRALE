import pytest

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.project import ProjectRuntimeConfig


def _config(tmp_path, **overrides) -> ProjectRuntimeConfig:
    values = {
        "project_root": tmp_path,
        "repository_id": "git@example.com:owner/repo.git",
        "sessions_dir": tmp_path / "sessions",
        "catalog_db": tmp_path / "catalog.sqlite",
    }
    values.update(overrides)
    return ProjectRuntimeConfig(**values)


def test_config_resolves_the_project_root(tmp_path) -> None:
    nested = tmp_path / "work" / "repo"
    nested.mkdir(parents=True)

    config = _config(tmp_path, project_root=nested / ".." / "repo")

    assert config.project_root == nested.resolve()
    assert config.project.project_root == str(nested.resolve())


def test_project_info_exposes_no_private_paths(tmp_path) -> None:
    config = _config(tmp_path)

    info = config.project

    assert info.project_root == str(tmp_path.resolve())
    assert info.repository_id == "git@example.com:owner/repo.git"
    assert info.project_id == "git@example.com:owner/repo.git"
    assert not hasattr(info, "sessions_dir")
    assert not hasattr(info, "catalog_db")


def test_project_id_defaults_to_the_repository_id(tmp_path) -> None:
    assert _config(tmp_path).project.project_id == "git@example.com:owner/repo.git"
    assert _config(tmp_path, project_id="proj-1").project.project_id == "proj-1"


def test_config_rejects_a_missing_project_root(tmp_path) -> None:
    with pytest.raises(ProjectConfigError, match="does not exist"):
        _config(tmp_path, project_root=tmp_path / "absent")


def test_config_rejects_a_file_as_project_root(tmp_path) -> None:
    target = tmp_path / "file.txt"
    target.write_text("x")

    with pytest.raises(ProjectConfigError, match="not a directory"):
        _config(tmp_path, project_root=target)


@pytest.mark.parametrize("repository_id", ["", "repo\x00name"])
def test_config_rejects_an_unusable_repository_id(tmp_path, repository_id) -> None:
    with pytest.raises(ProjectConfigError, match="repository_id"):
        _config(tmp_path, repository_id=repository_id)


@pytest.mark.parametrize("repository_id", ["/srv/checkout", "/srv/checkout/", "C:\\work\\repo", "\\\\host\\share"])
def test_config_rejects_a_repository_id_that_is_a_filesystem_path(tmp_path, repository_id) -> None:
    with pytest.raises(ProjectConfigError, match="not a filesystem path"):
        _config(tmp_path, repository_id=repository_id)


def test_config_rejects_an_unusable_default_lane(tmp_path) -> None:
    with pytest.raises(ProjectConfigError, match="default_lane"):
        _config(tmp_path, default_lane="")
