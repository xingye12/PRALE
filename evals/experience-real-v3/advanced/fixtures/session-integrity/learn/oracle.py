"""External advanced multi-module oracle entry point."""
import sys
from pathlib import Path

root = next(p for p in Path(__file__).resolve().parents if (p / 'scripts/real_experience_advanced_oracle.py').is_file())
sys.path.insert(0, str(root / 'scripts'))
from real_experience_advanced_oracle import main  # noqa: E402

raise SystemExit(main(Path(__file__).resolve().parent))
