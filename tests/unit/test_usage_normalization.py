"""Provider usage payloads differ; unreadable numbers must not become zero."""

import pytest

from agent_harness.domain.effects import UsageRecord, as_usage, normalize_usage


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        ({"input_tokens": 10, "output_tokens": 4}, (10, 4, 14)),
        ({"prompt_tokens": 10, "completion_tokens": 4}, (10, 4, 14)),
        ({"prompt_token_count": 10, "completion_token_count": 4}, (10, 4, 14)),
        # A provider that reports its own total is believed over the sum.
        ({"input_tokens": 10, "output_tokens": 4, "total_tokens": 99}, (10, 4, 99)),
        ({"input_tokens": 10, "output_tokens": 4, "total_token_count": 99}, (10, 4, 99)),
    ],
)
def test_known_provider_shapes_are_normalized(usage, expected) -> None:
    assert normalize_usage(usage) == expected


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        # A missing half is unknown, not zero: the total must not be invented.
        ({"input_tokens": 10}, (10, None, None)),
        ({"output_tokens": 4}, (None, 4, None)),
        ({}, (None, None, None)),
        ({"input_tokens": None, "output_tokens": 4}, (None, 4, None)),
        ({"input_tokens": "10", "output_tokens": 4}, (None, 4, None)),
        # Booleans are ints in Python and are never token counts.
        ({"input_tokens": True, "output_tokens": 4}, (None, 4, None)),
        ({"input_tokens": 10.7, "output_tokens": 4.2}, (10, 4, 14)),
    ],
)
def test_absent_or_unreadable_counts_stay_unknown(usage, expected) -> None:
    assert normalize_usage(usage) == expected


def test_a_first_known_key_wins_over_the_provider_aliases() -> None:
    assert normalize_usage({"input_tokens": 1, "prompt_tokens": 2, "output_tokens": 3}) == (1, 3, 4)


def test_narrowing_keeps_only_numeric_usage_fields() -> None:
    assert as_usage({"input_tokens": 3, "model": "x", "cached": None, "ratio": 0.5}) == {
        "input_tokens": 3,
        "ratio": 0.5,
    }
    assert as_usage("not a mapping") == {}
    assert as_usage({"flag": True}) == {}


def test_raw_usage_is_preserved_for_rows_we_do_not_understand() -> None:
    record = UsageRecord(
        id="usage-1",
        operation_id="op-1",
        entry_id="entry-1",
        span_id="span-1",
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
        raw={"weird_provider_field": 12, "note": "text"},
    )

    assert not record.legacy_unattributed
    assert record.raw["weird_provider_field"] == 12


def test_a_row_without_an_operation_can_never_be_attributed_to_a_turn() -> None:
    record = UsageRecord(
        id="usage-1",
        operation_id=None,
        entry_id="entry-1",
        span_id=None,
        input_tokens=1,
        output_tokens=1,
        total_tokens=2,
        raw={"total_tokens": 2},
    )

    assert record.legacy_unattributed
