"""Version-3 executable behavior and mutation-sensitive regression acceptance."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / 'scripts'))
from real_experience_oracle import main  # noqa: E402

raise SystemExit(main(Path(__file__).resolve().parent))
