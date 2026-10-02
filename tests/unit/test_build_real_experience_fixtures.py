from build_real_experience_fixtures import FIXTURES, ROOT, render


def test_real_pi_experience_fixtures_cover_learn_transfer_and_correction() -> None:
    rendered = render()

    assert len(FIXTURES) == 12
    assert len(rendered) == 36
    assert {fixture.episode for fixture in FIXTURES} == {
        "extension-trust",
        "session-migration",
        "tool-recovery-order",
    }
    assert {fixture.stage for fixture in FIXTURES} == {"learn", "transfer", "correction", "retransfer"}
    assert all((ROOT / fixture.episode / fixture.stage / "oracle.py") in rendered for fixture in FIXTURES)
