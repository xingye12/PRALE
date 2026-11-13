"""Task presentation variants; hidden target metadata never enters TASK.md."""

import json
from pathlib import Path


def task_for_visibility(fixture: Path, visibility: str) -> str:
    text = (fixture / "TASK.md").read_text(encoding="utf-8")
    if visibility == "listed":
        return text
    if visibility != "hidden":
        raise ValueError("target visibility must be listed or hidden")
    metadata = json.loads((fixture / "fixture.json").read_text(encoding="utf-8"))
    targets = metadata.get("targets", [metadata.get("target")])
    if metadata.get("oracle_version") == 3:
        sentence = f"Repair `{metadata['target']}` with minimal changes."
        if sentence not in text and "Locate the faulty production code" not in text:
            raise ValueError("unrecognized basic task presentation")
        text = text.replace(sentence, "Locate the faulty production code and repair it with minimal changes.", 1)
        text = text.replace(
            "Only modify the target source and add regression files under `.prale-eval/`.",
            "Modify only production code needed for this incident and add tests under `.prale-eval/`.",
        )
    elif metadata.get("oracle_version") == 4 and "Locate the faulty production code" not in text:
        start = text.index("Investigate the producer/consumer flow across these source modules;")
        end = text.index("## Delivery and local validation", start)
        text = (
            text[:start]
            + "Locate the faulty production code by investigating the incident. Preserve existing APIs.\n\n"
            + text[end:]
        )
        text = text.replace("Modify every listed production file,", "Apply the necessary production repairs,")
        text = text.replace(
            "Only modify the listed source modules and add files under `.prale-eval/`.",
            "Modify only production code needed for this incident and add tests under `.prale-eval/`.",
        )
    elif metadata.get("oracle_version") not in {3, 4}:
        raise ValueError("hidden target presentation requires a real-v2 behavioral fixture")
    if any(not isinstance(target, str) or target in text for target in targets):
        raise ValueError("hidden task still discloses a target path")
    return text
