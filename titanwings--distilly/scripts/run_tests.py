#!/usr/bin/env python3
"""Run the repository unittest suite and fail if discovery finds no tests."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Optional, TextIO

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def run(start_dir: Path, stream: Optional[TextIO] = None) -> int:
    """Discover and run tests below start_dir, rejecting an empty suite."""
    output = stream or sys.stderr
    if not start_dir.is_dir():
        output.write(f"tests: missing directory: {start_dir}\n")
        return 1

    suite = unittest.TestLoader().discover(str(start_dir), pattern="test_*.py")
    count = suite.countTestCases()
    if count == 0:
        output.write(f"tests: zero tests discovered in {start_dir}\n")
        return 1

    output.write(f"tests: discovered {count}\n")
    result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def main() -> int:
    return run(ROOT / "tests")


if __name__ == "__main__":
    raise SystemExit(main())
