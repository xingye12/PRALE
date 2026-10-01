import pytest
from judge_memory_eval import RUBRICS, validate_judgement


def _response(section: str) -> dict[str, object]:
    return {
        "items": [
            {
                "id": "case-1",
                "scores": {name: 4 for name in RUBRICS[section]},
                "overall": 4,
                "verdict": "pass",
                "reason": "all evidence is retained",
            }
        ]
    }


def test_judge_response_requires_all_rubric_dimensions_and_known_case_ids() -> None:
    assert validate_judgement("generation", ["case-1"], _response("generation"))[0]["overall"] == 4

    bad = _response("generation")
    bad["items"][0]["scores"] = {"evidence": 4}  # type: ignore[index]
    with pytest.raises(ValueError, match="wrong score dimensions"):
        validate_judgement("generation", ["case-1"], bad)
