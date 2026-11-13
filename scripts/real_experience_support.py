"""Controller-only selection of versioned public test support."""

from collections.abc import Mapping
from pathlib import Path

PUBLIC_SUBJECT = Path(__file__).with_name("real_experience_public_subject.mjs")


def subject_path(metadata: Mapping[str, object], legacy_directory: Path) -> Path:
    version = metadata.get("public_support_version")
    if version is None:
        return legacy_directory / "subject.mjs"
    if version == 1:
        return PUBLIC_SUBJECT
    raise ValueError("unsupported public test support version")
