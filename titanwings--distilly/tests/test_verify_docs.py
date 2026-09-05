"""Portable documentation gate behavior."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.verify_docs import verify


class VerifyDocsTests(unittest.TestCase):
    def _root(self, body: str) -> Path:
        root = Path(tempfile.mkdtemp())
        (root / "target.md").write_text("# Target\n", encoding="utf-8")
        (root / "README.md").write_text(body, encoding="utf-8")
        return root

    def test_accepts_relative_remote_and_fragment_links(self) -> None:
        root = self._root("# Placeholder\n")
        (root / "a(b).md").write_text("# Parentheses\n", encoding="utf-8")
        (root / "README.md").write_text(
            "# Docs\n\n[target](target.md) [paren](a(b).md) "
            "[web](https://example.com) [top](#docs) [target heading](target.md#target)\n",
            encoding="utf-8",
        )
        self.assertEqual(verify(root, check_design=False), [])

    def test_rejects_missing_absolute_escaping_and_wiki_links(self) -> None:
        outside = Path(tempfile.mkdtemp()) / "outside.md"
        outside.write_text("outside\n", encoding="utf-8")
        root = self._root(
            "# Docs\n\n[missing](missing.md)\n"
            "[absolute](/tmp/file.md)\n"
            f"[outside]({outside})\n"
            "[[private-note]]\n"
        )
        errors = verify(root, check_design=False)
        self.assertTrue(any("missing local target" in error for error in errors), errors)
        self.assertTrue(any("repository-relative" in error for error in errors), errors)
        self.assertTrue(any("wiki links" in error for error in errors), errors)
        self.assertTrue(all(":3:" in error or ":4:" in error or ":5:" in error or ":6:" in error for error in errors), errors)

    def test_rejects_missing_reference_and_file_url(self) -> None:
        root = self._root(
            "# Docs\n\n[missing][id]\n[undefined][absent]\n\n"
            "[id]: missing.md\n[file](file:///tmp/x)\n"
        )
        errors = verify(root, check_design=False)
        self.assertTrue(any("missing local target" in error for error in errors), errors)
        self.assertTrue(any("undefined reference link" in error for error in errors), errors)
        self.assertTrue(any("repository-relative" in error for error in errors), errors)

    def test_accepts_defined_reference_link(self) -> None:
        root = self._root("# Docs\n\n[target][id]\n\n[id]: target.md\n")
        self.assertEqual(verify(root, check_design=False), [])

    def test_ignores_links_inside_code(self) -> None:
        root = self._root(
            "# Docs\n\n`[inline](missing.md)`\n"
            "``[double](missing.md)``\n\n"
            "```md\n[code](missing.md)\n```\n"
        )
        self.assertEqual(verify(root, check_design=False), [])

    def test_ignores_indented_code_escaped_links_and_html_comments(self) -> None:
        root = self._root(
            "# Docs\n\n    [indented](missing.md)\n\n"
            "\\[escaped](missing.md)\n\n"
            "<!-- [commented](missing.md)\n"
            "[still-commented](missing.md) -->\n"
        )
        self.assertEqual(verify(root, check_design=False), [])

    def test_rejects_unquoted_html_target_and_unclosed_markdown_link(self) -> None:
        root = self._root(
            "# Docs\n\n<a href=missing.md>missing</a>\n"
            "[unclosed](missing.md\n"
        )
        errors = verify(root, check_design=False)
        self.assertTrue(any("missing local target" in error for error in errors), errors)
        self.assertTrue(any("unclosed Markdown" in error for error in errors), errors)

    def test_rejects_missing_markdown_fragment(self) -> None:
        root = self._root("# Docs\n\n[bad](target.md#not-there)\n")
        errors = verify(root, check_design=False)
        self.assertTrue(any("missing Markdown anchor" in error for error in errors), errors)

    def test_indented_fence_does_not_hide_following_prose(self) -> None:
        root = self._root("# Docs\n\n    ```md\n[bad](missing.md)\n")
        errors = verify(root, check_design=False)
        self.assertTrue(any("missing local target" in error for error in errors), errors)

    def test_fence_suffix_is_not_a_closing_fence(self) -> None:
        root = self._root(
            "# Docs\n\n```md\n[inside](missing.md)\n"
            "```not-a-close\n[still-inside](missing.md)\n```\n"
        )
        self.assertEqual(verify(root, check_design=False), [])

    def test_requires_exactly_one_trailing_newline(self) -> None:
        no_newline = self._root("# Docs")
        errors = verify(no_newline, check_design=False)
        self.assertTrue(any("end with a newline" in error for error in errors), errors)
        two_newlines = self._root("# Docs\n\n")
        errors = verify(two_newlines, check_design=False)
        self.assertTrue(any("exactly one newline" in error for error in errors), errors)

    def test_ignores_gitignored_markdown(self) -> None:
        root = self._root("# Docs\n")
        (root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
        ignored = root / "ignored/bad.md"
        ignored.parent.mkdir()
        ignored.write_text("[[private]]\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "add", ".gitignore", "README.md", "target.md"], cwd=root, check=True)
        self.assertEqual(verify(root, check_design=False), [])

    @patch("scripts.verify_docs.subprocess.run")
    def test_rejects_non_utf8_markdown_path(self, run) -> None:
        run.return_value.returncode = 0
        run.return_value.stdout = b"\xff.md\0"
        root = Path(tempfile.mkdtemp())
        (root / ".git").mkdir()
        errors = verify(root, check_design=False)
        self.assertTrue(any("not valid UTF-8" in error for error in errors), errors)

    @patch("scripts.verify_docs.subprocess.run")
    def test_git_enumeration_failure_is_not_a_filesystem_fallback(self, run) -> None:
        run.return_value.returncode = 128
        run.return_value.stderr = b"bad index"
        root = Path(tempfile.mkdtemp())
        (root / ".git").mkdir()
        (root / "ignored.md").write_text("[[bad]]\n", encoding="utf-8")
        errors = verify(root, check_design=False)
        self.assertEqual(errors, ["cannot enumerate Markdown with git: bad index"])


if __name__ == "__main__":
    unittest.main()
