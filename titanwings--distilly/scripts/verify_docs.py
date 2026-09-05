#!/usr/bin/env python3
"""Check portable Markdown links, file endings, and generated design chapters."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Tuple
from urllib.parse import unquote

try:
    from scripts.sync_design_chapters import verify as verify_design_chapters
except ModuleNotFoundError:  # Direct execution puts scripts/ on sys.path.
    from sync_design_chapters import verify as verify_design_chapters

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".mypy_cache", ".ruff_cache", ".venv", "node_modules"}
HTML_LINK_RE = re.compile(
    r"(?:href|src)\s*=\s*(?:([\"'])([^\"']*)\1|([^\s\"'=<>`]+))",
    re.IGNORECASE,
)
HTML_ID_RE = re.compile(
    r"(?:id|name)\s*=\s*(?:([\"'])([^\"']*)\1|([^\s\"'=<>`]+))",
    re.IGNORECASE,
)
REFERENCE_DEF_RE = re.compile(r"^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)")
REFERENCE_USE_RE = re.compile(r"!?\[([^\]\n]+)\]\[([^\]\n]*)\]")
WIKI_LINK_RE = re.compile(r"\[\[[^\]\n]+\]\]")
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)$")
ATX_HEADING_RE = re.compile(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$")
SETEXT_HEADING_RE = re.compile(r"^ {0,3}(?:=+|-+)\s*$")


def _markdown_files(root: Path) -> Iterable[Path]:
    git_marker = root / ".git"
    if git_marker.exists():
        try:
            result = subprocess.run(
                [
                    "git",
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "--",
                    "*.md",
                ],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except OSError as exc:
            raise ValueError(f"cannot enumerate Markdown with git: {exc}") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(
                "cannot enumerate Markdown with git: " + (detail or "git failed")
            )
        for raw in sorted(part for part in result.stdout.split(b"\0") if part):
            try:
                relative = Path(raw.decode("utf-8"))
            except UnicodeError as exc:
                raise ValueError(
                    "git reported a Markdown path that is not valid UTF-8"
                ) from exc
            path = root / relative
            if path.exists() or path.is_symlink():
                yield path
        return

    for path in sorted(root.rglob("*.md")):
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if any(part in SKIP_DIRS for part in relative.parts):
            continue
        yield path


def _opening_fence(line: str) -> Optional[Tuple[str, int]]:
    match = FENCE_RE.match(line)
    if match is None:
        return None
    token, info = match.groups()
    if token[0] == "`" and "`" in info:
        return None
    return token[0], len(token)


def _closes_fence(line: str, char: str, length: int) -> bool:
    match = FENCE_RE.match(line)
    if match is None:
        return False
    token, suffix = match.groups()
    return token[0] == char and len(token) >= length and not suffix.strip()


def _code_ranges(line: str) -> List[Tuple[int, int]]:
    ranges: List[Tuple[int, int]] = []
    index = 0
    while index < len(line):
        if line[index] != "`":
            index += 1
            continue
        opener_end = index
        while opener_end < len(line) and line[opener_end] == "`":
            opener_end += 1
        token_length = opener_end - index
        search = opener_end
        close_end = None
        while search < len(line):
            candidate = line.find("`", search)
            if candidate < 0:
                break
            candidate_end = candidate
            while candidate_end < len(line) and line[candidate_end] == "`":
                candidate_end += 1
            if candidate_end - candidate == token_length:
                close_end = candidate_end
                break
            search = candidate_end
        if close_end is None:
            index = opener_end
            continue
        ranges.append((index, close_end))
        index = close_end
    return ranges


def _without_inline_code(line: str) -> str:
    visible = list(line)
    for start, end in _code_ranges(line):
        visible[start:end] = " " * (end - start)
    return "".join(visible)


def _is_escaped(line: str, position: int) -> bool:
    slashes = 0
    position -= 1
    while position >= 0 and line[position] == "\\":
        slashes += 1
        position -= 1
    return slashes % 2 == 1


def _without_escaped_markers(line: str) -> str:
    visible = list(line)
    for index, char in enumerate(line):
        if char in "[]()" and _is_escaped(line, index):
            visible[index] = " "
    return "".join(visible)


def _without_html_comments(line: str, in_comment: bool) -> Tuple[str, bool]:
    visible = list(line)
    cursor = 0
    while cursor < len(line):
        if in_comment:
            end = line.find("-->", cursor)
            if end < 0:
                visible[cursor:] = " " * (len(line) - cursor)
                return "".join(visible), True
            visible[cursor : end + 3] = " " * (end + 3 - cursor)
            cursor = end + 3
            in_comment = False
            continue
        start = line.find("<!--", cursor)
        if start < 0:
            break
        end = line.find("-->", start + 4)
        if end < 0:
            visible[start:] = " " * (len(line) - start)
            return "".join(visible), True
        visible[start : end + 3] = " " * (end + 3 - start)
        cursor = end + 3
    return "".join(visible), in_comment


def _visible_lines(text: str) -> Iterable[Tuple[int, str]]:
    fence_char = None
    fence_length = 0
    in_comment = False
    in_indented_code = False
    previous_blank = True
    for number, line in enumerate(text.splitlines(), 1):
        if fence_char is not None:
            if _closes_fence(line, fence_char, fence_length):
                fence_char = None
                fence_length = 0
            continue

        if in_indented_code:
            if not line.strip() or line.startswith(("    ", "\t")):
                previous_blank = not line.strip()
                continue
            in_indented_code = False
        if previous_blank and line.startswith(("    ", "\t")):
            in_indented_code = True
            previous_blank = False
            continue

        visible = _without_inline_code(line)
        visible, in_comment = _without_html_comments(visible, in_comment)
        opening = _opening_fence(visible)
        if opening is not None:
            fence_char, fence_length = opening
            previous_blank = False
            continue
        visible = _without_escaped_markers(visible)
        yield number, visible
        previous_blank = not visible.strip()


def _markdown_targets(line: str) -> Tuple[List[str], bool]:
    """Return inline link destinations and whether one is unclosed."""
    targets: List[str] = []
    brackets: List[int] = []
    index = 0
    while index < len(line):
        char = line[index]
        if char == "[" and not _is_escaped(line, index):
            brackets.append(index)
            index += 1
            continue
        if char != "]" or _is_escaped(line, index) or not brackets:
            index += 1
            continue
        brackets.pop()
        if index + 1 >= len(line) or line[index + 1] != "(":
            index += 1
            continue

        start = index + 2
        depth = 1
        cursor = start
        while cursor < len(line):
            destination_char = line[cursor]
            if _is_escaped(line, cursor):
                cursor += 1
                continue
            if destination_char == "(":
                depth += 1
            elif destination_char == ")":
                depth -= 1
                if depth == 0:
                    targets.append(line[start:cursor])
                    index = cursor + 1
                    break
            cursor += 1
        else:
            return targets, True
    return targets, False


def _target_token(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("<") and ">" in raw:
        return raw[1 : raw.index(">")]
    return raw.split(maxsplit=1)[0] if raw else ""


def _normalize_reference(label: str) -> str:
    return " ".join(label.split()).casefold()


def _heading_slug(text: str) -> str:
    text = re.sub(r"<[^>]*>", "", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.replace("`", "")
    lowered = text.casefold().strip()
    kept = "".join(
        char for char in lowered if char.isalnum() or char in {" ", "\t", "-", "_"}
    )
    return re.sub(r"[ \t]", "-", kept)


def _markdown_anchors(path: Path) -> set[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return set()
    anchors: set[str] = set()
    slug_counts: dict[str, int] = {}
    previous: Optional[str] = None
    for _, line in _visible_lines(text):
        for match in HTML_ID_RE.finditer(line):
            anchors.add(unquote(match.group(2) or match.group(3)))
        heading = ATX_HEADING_RE.match(line)
        heading_text = heading.group(1) if heading else None
        if heading_text is None and SETEXT_HEADING_RE.match(line) and previous:
            heading_text = previous
        if heading_text is not None:
            base = _heading_slug(heading_text)
            count = slug_counts.get(base, 0)
            slug_counts[base] = count + 1
            anchors.add(base if count == 0 else f"{base}-{count}")
        previous = line.strip() or None
    return anchors


def _check_target(path: Path, line: int, raw: str, root: Path) -> List[str]:
    target = _target_token(raw)
    if not target or target.startswith("//"):
        return []
    rel = path.relative_to(root).as_posix()
    if (
        target.lower().startswith("file:")
        or re.match(r"^[A-Za-z]:", target)
        or target.startswith(("/", "~"))
    ):
        return [f"{rel}:{line}: local links must be repository-relative: {target}"]
    if SCHEME_RE.match(target):
        return []

    path_and_query, separator, fragment = target.partition("#")
    path_part = unquote(path_and_query.split("?", 1)[0])
    resolved = (path.parent / path_part).resolve() if path_part else path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return [f"{rel}:{line}: local link escapes repository: {target}"]
    if not resolved.exists():
        return [f"{rel}:{line}: missing local target: {target}"]
    if separator and fragment and resolved.suffix.lower() == ".md":
        wanted = unquote(fragment)
        if wanted not in _markdown_anchors(resolved):
            return [f"{rel}:{line}: missing Markdown anchor: {target}"]
    return []


def _check_markdown(path: Path, root: Path) -> List[str]:
    rel = path.relative_to(root).as_posix()
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return [f"{rel}: cannot read as UTF-8: {exc}"]

    errors: List[str] = []
    if not text.endswith("\n"):
        errors.append(f"{rel}: file must end with a newline")
    elif text.endswith("\n\n"):
        errors.append(f"{rel}: file must end with exactly one newline")

    visible_lines = list(_visible_lines(text))
    definitions: dict[str, int] = {}
    for number, line in visible_lines:
        definition = REFERENCE_DEF_RE.match(line)
        if definition and not definition.group(1).startswith("^"):
            label = _normalize_reference(definition.group(1))
            if label in definitions:
                errors.append(f"{rel}:{number}: duplicate reference definition: {label}")
            else:
                definitions[label] = number

    for number, line in visible_lines:
        if WIKI_LINK_RE.search(line):
            errors.append(
                f"{rel}:{number}: Obsidian wiki links are not portable; use Markdown"
            )
        targets, unclosed = _markdown_targets(line)
        if unclosed:
            errors.append(f"{rel}:{number}: unclosed Markdown link destination")
        targets.extend(
            match.group(2) or match.group(3) for match in HTML_LINK_RE.finditer(line)
        )
        reference = REFERENCE_DEF_RE.match(line)
        if reference and not reference.group(1).startswith("^"):
            targets.append(reference.group(2))
        for target in targets:
            errors.extend(_check_target(path, number, target, root))
        for usage in REFERENCE_USE_RE.finditer(line):
            label = _normalize_reference(usage.group(2) or usage.group(1))
            if label not in definitions:
                errors.append(f"{rel}:{number}: undefined reference link: {label}")
    return errors


def verify(root: Path = ROOT, *, check_design: bool = True) -> List[str]:
    try:
        markdown_files = list(_markdown_files(root))
    except ValueError as exc:
        return [str(exc)]
    errors: List[str] = []
    for path in markdown_files:
        errors.extend(_check_markdown(path, root))
    if check_design:
        errors.extend(verify_design_chapters(root))
    return sorted(errors)


def main() -> int:
    errors = verify()
    if errors:
        sys.stderr.write("\n".join(errors) + "\n")
        return 1
    sys.stdout.write("docs: ok\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
