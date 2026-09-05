"""Fail-closed unittest discovery behavior."""

from __future__ import annotations

import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.run_tests import run


class RunTestsTests(unittest.TestCase):
    def test_rejects_empty_test_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = io.StringIO()
            result = run(Path(temporary), output)
        self.assertEqual(result, 1)
        self.assertIn("zero tests", output.getvalue())

    def test_runs_discovered_test(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            start_dir = Path(temporary)
            (start_dir / "test_example.py").write_text(
                "import unittest\n\n"
                "class ExampleTest(unittest.TestCase):\n"
                "    def test_ok(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            output = io.StringIO()
            result = run(start_dir, output)
        self.assertEqual(result, 0)
        self.assertIn("discovered 1", output.getvalue())

    @patch.object(
        unittest.defaultTestLoader,
        "discover",
        side_effect=AssertionError("global loader must not be reused"),
    )
    def test_uses_fresh_loader_when_called_from_another_suite(self, _discover) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            start_dir = Path(temporary)
            (start_dir / "test_nested.py").write_text(
                "import unittest\n\n"
                "class NestedTest(unittest.TestCase):\n"
                "    def test_ok(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            result = run(start_dir, io.StringIO())
        self.assertEqual(result, 0)

    def test_cli_adds_repository_root_to_import_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scripts = root / "scripts"
            tests = root / "tests"
            scripts.mkdir()
            tests.mkdir()
            shutil.copyfile(
                Path(__file__).resolve().parents[1] / "scripts/run_tests.py",
                scripts / "run_tests.py",
            )
            (scripts / "__init__.py").write_text("", encoding="utf-8")
            (scripts / "helper.py").write_text("VALUE = 1\n", encoding="utf-8")
            (tests / "test_import.py").write_text(
                "import unittest\n"
                "from scripts.helper import VALUE\n\n"
                "class ImportTest(unittest.TestCase):\n"
                "    def test_import(self):\n"
                "        self.assertEqual(VALUE, 1)\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, "-B", "scripts/run_tests.py"],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
