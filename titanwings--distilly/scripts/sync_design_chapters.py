#!/usr/bin/env python3
"""Generate the topic-sized design chapters from the canonical design file."""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
SECTION_RE = re.compile(r"^## (\d+)\.\s+.+$")
HTML_TARGET_RE = re.compile(
    r"((?:href|src)\s*=\s*)(?:([\"'])([^\"']*)\2|([^\s\"'=<>`]+))",
    re.IGNORECASE,
)
REFERENCE_TARGET_RE = re.compile(r"^(\s*\[[^\]]+\]:\s*)(<[^>]+>|\S+)")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)$")


@dataclass(frozen=True)
class Corpus:
    """A canonical design file and the chapter projections it owns.

    Chapter names are positional: index `n` receives design section `## n.`.
    """

    version: int
    status: str
    successor: Optional[int]
    parent: Path
    chapter_dir: Path
    names: Tuple[str, ...]
    preamble: str


V3 = Corpus(
    version=3,
    status="in_force",
    successor=None,
    parent=Path("docs/design/system-v3.md"),
    chapter_dir=Path("docs/design/v3"),
    names=(
        "00-how-to-read.md",
        "01-product.md",
        "02-user-journeys.md",
        "03-locked-and-superseded.md",
        "04-trust-and-principles.md",
        "05-architecture-and-state.md",
        "06-storage-authority-and-transactions.md",
        "07-protocol-types.md",
        "08-mcp-tools.md",
        "09-subject-identity.md",
        "10-research-provenance.md",
        "11-ingest-and-queue.md",
        "12-briefing-and-lease.md",
        "13-profile-and-claims.md",
        "14-commit-and-quality.md",
        "15-local-panel.md",
        "16-recall-and-injection.md",
        "17-host-bindings.md",
        "18-public-sdk.md",
        "19-cli-and-plugins.md",
        "20-corrections-and-evolution.md",
        "21-background-executor.md",
        "22-relations.md",
        "23-index-and-search.md",
        "24-profile-catalog.md",
        "25-package-and-source-tree.md",
        "26-security-config-telemetry.md",
        "27-testing-and-governance.md",
        "28-migration-and-compatibility.md",
        "29-landing-and-evolution.md",
    ),
    preamble=(
        "> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；"
        "当前已发布行为以 [architecture.md](../../architecture.md) 为准。"
        "请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。\n\n"
    ),
)
CORPORA: Tuple[Corpus, ...] = (V3,)


class DesignSyncError(ValueError):
    """The canonical design cannot be mapped one-to-one to its chapters."""


def validate_corpora(corpora: Sequence[Corpus]) -> None:
    """Fail before generation when the corpus registry is ambiguous."""
    if not corpora:
        raise DesignSyncError("design corpus registry must not be empty")

    parents: Dict[Path, int] = {}
    chapter_dirs: Dict[Path, int] = {}
    outputs: Dict[Path, int] = {}
    versions: Dict[int, Corpus] = {}
    in_force = 0

    for corpus in corpora:
        if corpus.status not in {"deprecated", "in_force"}:
            raise DesignSyncError(
                f"design v{corpus.version}: unknown status {corpus.status!r}"
            )
        if corpus.status == "in_force":
            in_force += 1
            if corpus.successor is not None:
                raise DesignSyncError(
                    f"design v{corpus.version}: in-force corpus cannot have a successor"
                )
        elif corpus.successor is None or corpus.successor <= corpus.version:
            raise DesignSyncError(
                f"design v{corpus.version}: deprecated corpus needs a later successor"
            )

        expected_parent = Path(f"docs/design/system-v{corpus.version}.md")
        expected_dir = Path(f"docs/design/v{corpus.version}")
        if corpus.parent != expected_parent or corpus.chapter_dir != expected_dir:
            raise DesignSyncError(
                f"design v{corpus.version}: expected {expected_parent.as_posix()} "
                f"and {expected_dir.as_posix()}"
            )

        if corpus.version in versions:
            raise DesignSyncError(f"design v{corpus.version}: duplicate version")
        versions[corpus.version] = corpus

        if corpus.parent in parents:
            raise DesignSyncError(
                f"{corpus.parent.as_posix()}: shared by design v"
                f"{parents[corpus.parent]} and v{corpus.version}"
            )
        parents[corpus.parent] = corpus.version

        if corpus.chapter_dir in chapter_dirs:
            raise DesignSyncError(
                f"{corpus.chapter_dir.as_posix()}: shared by design v"
                f"{chapter_dirs[corpus.chapter_dir]} and v{corpus.version}"
            )
        chapter_dirs[corpus.chapter_dir] = corpus.version

        if len(set(corpus.names)) != len(corpus.names):
            raise DesignSyncError(
                f"design v{corpus.version}: chapter names must be unique"
            )
        for number, name in enumerate(corpus.names):
            match = re.match(r"^(\d{2})-", name)
            if match is None or int(match.group(1)) != number:
                raise DesignSyncError(
                    f"design v{corpus.version}: chapter {number} must start "
                    f"with {number:02d}-"
                )
            output = corpus.chapter_dir / name
            if output in outputs:
                raise DesignSyncError(
                    f"{output.as_posix()}: produced by design v"
                    f"{outputs[output]} and v{corpus.version}"
                )
            outputs[output] = corpus.version

    if in_force != 1:
        raise DesignSyncError(
            f"design corpus registry must have exactly one in-force corpus; found {in_force}"
        )

    for corpus in corpora:
        if corpus.successor is not None and corpus.successor not in versions:
            raise DesignSyncError(
                f"design v{corpus.version}: successor v{corpus.successor} is not registered"
            )


def _opening_fence(line: str) -> Optional[Tuple[str, int]]:
    match = FENCE_RE.match(line.rstrip("\r\n"))
    if match is None:
        return None
    token, info = match.groups()
    if token[0] == "`" and "`" in info:
        return None
    return token[0], len(token)


def _closes_fence(line: str, char: str, length: int) -> bool:
    match = FENCE_RE.match(line.rstrip("\r\n"))
    if match is None:
        return False
    token, suffix = match.groups()
    return token[0] == char and len(token) >= length and not suffix.strip()


def _section_markers(text: str) -> List[Tuple[int, int]]:
    markers: List[Tuple[int, int]] = []
    fence_char = None
    fence_length = 0
    offset = 0
    for line in text.splitlines(keepends=True):
        if fence_char is None:
            opening = _opening_fence(line)
            if opening is not None:
                fence_char, fence_length = opening
            else:
                heading = SECTION_RE.match(line.rstrip("\r\n"))
                if heading:
                    markers.append((int(heading.group(1)), offset))
        elif _closes_fence(line, fence_char, fence_length):
            fence_char = None
            fence_length = 0
        offset += len(line)
    return markers


def extract_sections(text: str, count: int) -> Dict[int, str]:
    """Return numbered top-level sections without inter-section separators."""
    markers = _section_markers(text)
    numbers = [number for number, _ in markers]
    expected = list(range(count))
    if numbers != expected:
        raise DesignSyncError(
            f"design sections must be exactly 0..{count - 1}; found "
            + ", ".join(str(number) for number in numbers)
        )

    sections: Dict[int, str] = {}
    for index, (number, start) in enumerate(markers):
        end = markers[index + 1][1] if index + 1 < len(markers) else len(text)
        section = text[start:end].rstrip()
        if section.endswith("\n---"):
            section = section[:-4].rstrip()
        sections[number] = section + "\n"
    return sections


def _rewrite_target(raw: str, source_dir: Path, target_dir: Path) -> str:
    original = raw
    raw = raw.strip()
    if raw.startswith("<") and ">" in raw:
        close = raw.index(">")
        target = raw[1:close]
        suffix = raw[close + 1 :]
        wrapped = True
    else:
        parts = raw.split(maxsplit=1)
        target = parts[0]
        suffix = " " + parts[1] if len(parts) == 2 else ""
        wrapped = False

    if (
        not target
        or target.startswith(("#", "//"))
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target)
    ):
        return original

    path_match = re.match(r"^([^?#]*)(.*)$", target)
    if path_match is None:
        return original
    path_part, suffix_target = path_match.groups()
    if not path_part or path_part.startswith("/"):
        return original
    resolved = (source_dir / path_part).resolve()
    rewritten = os.path.relpath(str(resolved), str(target_dir.resolve())).replace(
        os.sep, "/"
    )
    rewritten += suffix_target
    rendered = "<" + rewritten + ">" if wrapped else rewritten
    return rendered + suffix


def _code_ranges(line: str) -> List[Tuple[int, int]]:
    ranges: List[Tuple[int, int]] = []
    index = 0
    while index < len(line):
        if line[index] != "`":
            index += 1
            continue
        end_run = index
        while end_run < len(line) and line[end_run] == "`":
            end_run += 1
        token_length = end_run - index
        search = end_run
        close = None
        close_end = None
        while search < len(line):
            candidate = line.find("`", search)
            if candidate < 0:
                break
            candidate_end = candidate
            while candidate_end < len(line) and line[candidate_end] == "`":
                candidate_end += 1
            if candidate_end - candidate == token_length:
                close = candidate
                close_end = candidate_end
                break
            search = candidate_end
        if close is None or close_end is None:
            index = end_run
            continue
        ranges.append((index, close_end))
        index = close_end
    return ranges


def _inside(position: int, ranges: List[Tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in ranges)


def _is_escaped(line: str, position: int) -> bool:
    slashes = 0
    position -= 1
    while position >= 0 and line[position] == "\\":
        slashes += 1
        position -= 1
    return slashes % 2 == 1


def _html_comment_ranges(
    line: str, in_comment: bool
) -> Tuple[List[Tuple[int, int]], bool]:
    ranges: List[Tuple[int, int]] = []
    cursor = 0
    while cursor < len(line):
        if in_comment:
            end = line.find("-->", cursor)
            if end < 0:
                ranges.append((cursor, len(line)))
                return ranges, True
            ranges.append((cursor, end + 3))
            cursor = end + 3
            in_comment = False
            continue
        start = line.find("<!--", cursor)
        if start < 0:
            break
        end = line.find("-->", start + 4)
        if end < 0:
            ranges.append((start, len(line)))
            return ranges, True
        ranges.append((start, end + 3))
        cursor = end + 3
    return ranges, in_comment


def _masked(line: str, ranges: List[Tuple[int, int]]) -> str:
    visible = list(line)
    for start, end in ranges:
        visible[start:end] = " " * (end - start)
    return "".join(visible)


def _rewrite_visible_line(
    line: str,
    source_dir: Path,
    target_dir: Path,
    excluded_ranges: Optional[List[Tuple[int, int]]] = None,
) -> str:
    hidden_ranges = list(excluded_ranges or []) + _code_ranges(line)
    replacements: List[Tuple[int, int, str]] = []

    brackets: List[int] = []
    cursor = 0
    while cursor < len(line):
        if _inside(cursor, hidden_ranges):
            cursor += 1
            continue
        char = line[cursor]
        if char == "[" and not _is_escaped(line, cursor):
            brackets.append(cursor)
            cursor += 1
            continue
        if char != "]" or _is_escaped(line, cursor) or not brackets:
            cursor += 1
            continue
        brackets.pop()
        if cursor + 1 >= len(line) or line[cursor + 1] != "(":
            cursor += 1
            continue

        start = cursor + 2
        depth = 1
        index = start
        while index < len(line):
            destination_char = line[index]
            if _is_escaped(line, index):
                index += 1
                continue
            if destination_char == "(":
                depth += 1
            elif destination_char == ")":
                depth -= 1
                if depth == 0:
                    raw = line[start:index]
                    replacements.append(
                        (start, index, _rewrite_target(raw, source_dir, target_dir))
                    )
                    cursor = index + 1
                    break
            index += 1
        else:
            raise DesignSyncError("unclosed Markdown link in canonical design")

    for match in HTML_TARGET_RE.finditer(line):
        target_group = 3 if match.group(3) is not None else 4
        if not _inside(match.start(target_group), hidden_ranges):
            replacements.append(
                (
                    match.start(target_group),
                    match.end(target_group),
                    _rewrite_target(
                        match.group(target_group), source_dir, target_dir
                    ),
                )
            )
    reference = REFERENCE_TARGET_RE.match(line)
    if reference and not _inside(reference.start(2), hidden_ranges):
        replacements.append(
            (
                reference.start(2),
                reference.end(2),
                _rewrite_target(reference.group(2), source_dir, target_dir),
            )
        )

    for start, end, value in sorted(replacements, reverse=True):
        line = line[:start] + value + line[end:]
    return line


def _rewrite_relative_links(text: str, source_dir: Path, target_dir: Path) -> str:
    """Keep links valid when a section moves one directory deeper."""
    rewritten: List[str] = []
    fence_char = None
    fence_length = 0
    in_comment = False
    in_indented_code = False
    previous_blank = True
    for line in text.splitlines(keepends=True):
        if fence_char is not None:
            rewritten.append(line)
            if _closes_fence(line, fence_char, fence_length):
                fence_char = None
                fence_length = 0
            continue

        if in_indented_code:
            if not line.strip() or line.startswith(("    ", "\t")):
                rewritten.append(line)
                previous_blank = not line.strip()
                continue
            in_indented_code = False
        if previous_blank and line.startswith(("    ", "\t")):
            in_indented_code = True
            rewritten.append(line)
            previous_blank = False
            continue

        comment_ranges, in_comment = _html_comment_ranges(line, in_comment)
        visible = _masked(line, comment_ranges)
        opening = _opening_fence(visible)
        if opening is not None:
            fence_char, fence_length = opening
            rewritten.append(line)
            previous_blank = False
            continue
        rewritten.append(
            _rewrite_visible_line(
                line, source_dir, target_dir, excluded_ranges=comment_ranges
            )
        )
        previous_blank = not visible.strip()
    return "".join(rewritten)


def chapters_for(root: Path, corpus: Corpus) -> Dict[Path, str]:
    """Return the chapter projections one canonical design owns."""
    parent = root / corpus.parent
    if not parent.is_file():
        raise DesignSyncError(f"{corpus.parent.as_posix()} is missing")
    text = parent.read_text(encoding="utf-8")
    sections = extract_sections(text, len(corpus.names))
    chapter_dir = root / corpus.chapter_dir
    expected: Dict[Path, str] = {}
    for number, name in enumerate(corpus.names):
        body = _rewrite_relative_links(sections[number], parent.parent, chapter_dir)
        expected[chapter_dir / name] = corpus.preamble + body + "\n---\n"
    return expected


def expected_chapters(
    root: Path = ROOT, corpora: Sequence[Corpus] = CORPORA
) -> Dict[Path, str]:
    """Return every chapter projection across the given canonical designs."""
    validate_corpora(corpora)
    expected: Dict[Path, str] = {}
    for corpus in corpora:
        for path, content in chapters_for(root, corpus).items():
            if path in expected:
                rel = path.relative_to(root).as_posix()
                raise DesignSyncError(f"{rel}: duplicate generated output")
            expected[path] = content
    return expected


def _verify_corpus(root: Path, corpus: Corpus) -> List[str]:
    try:
        expected = chapters_for(root, corpus)
    except (OSError, UnicodeError, DesignSyncError) as exc:
        return [str(exc)]

    errors: List[str] = []
    chapter_dir = root / corpus.chapter_dir
    expected_names = {path.name for path in expected}
    if chapter_dir.is_dir():
        for path in sorted(chapter_dir.glob("[0-9][0-9]-*.md")):
            if path.name not in expected_names:
                rel = path.relative_to(root).as_posix()
                errors.append(f"{rel}: unexpected design chapter")

    for path, wanted in expected.items():
        rel = path.relative_to(root).as_posix()
        if not path.is_file():
            errors.append(f"{rel}: generated design chapter is missing")
            continue
        try:
            actual = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{rel}: cannot read generated chapter: {exc}")
            continue
        if actual != wanted:
            errors.append(
                f"{rel}: differs from {corpus.parent.as_posix()}; "
                "run `python3 scripts/sync_design_chapters.py`"
            )
    return errors


def verify(root: Path = ROOT, corpora: Sequence[Corpus] = CORPORA) -> List[str]:
    """Report missing, extra, or stale generated chapters in every corpus."""
    try:
        validate_corpora(corpora)
    except DesignSyncError as exc:
        return [str(exc)]
    errors: List[str] = []
    for corpus in corpora:
        errors.extend(_verify_corpus(root, corpus))
    return errors


def write(root: Path = ROOT, corpora: Sequence[Corpus] = CORPORA) -> List[Path]:
    """Write canonical chapter projections and return the changed paths."""
    expected = expected_chapters(root, corpora)
    changed: List[Path] = []
    for path, wanted in expected.items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == wanted:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(wanted, encoding="utf-8")
        changed.append(path)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift without rewriting generated chapters",
    )
    args = parser.parse_args()

    if args.check:
        errors = verify()
        if errors:
            sys.stderr.write("\n".join(errors) + "\n")
            return 1
        sys.stdout.write("design chapters: ok\n")
        return 0

    try:
        changed = write()
    except (OSError, UnicodeError, DesignSyncError) as exc:
        sys.stderr.write(str(exc) + "\n")
        return 1
    sys.stdout.write(f"design chapters: synchronized ({len(changed)} changed)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
