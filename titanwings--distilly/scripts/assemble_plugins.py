#!/usr/bin/env python3
"""Assemble and verify Distilly's source plugin release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence


ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
SENTINEL = "__DISTILLY_LAUNCHER_ABSOLUTE_PATH__"
CANONICAL_SKILL_ROOT = "plugins/shared/skills/distilly"
RELEASE_MANIFEST = "plugins/release-manifest.json"
MCP_PACKAGE_MANIFEST = "packages/mcp/package.json"


class PluginAssemblyError(ValueError):
    """A source plugin tree violates the release assembly contract."""


@dataclass(frozen=True)
class SkillFile:
    """One canonical skill file and its raw bytes."""

    path: str
    content_digest: str
    content: bytes


@dataclass(frozen=True)
class SkillTree:
    """A validated recursive skill tree."""

    digest: str
    files: tuple[SkillFile, ...]


@dataclass(frozen=True)
class Target:
    """One exact host release target."""

    host: str
    plugin_root: str
    plugin_manifest_path: str
    skill_root: str
    template_path: str


TARGETS = (
    Target(
        host="claude-code",
        plugin_root="plugins/claude-code",
        plugin_manifest_path="plugins/claude-code/.claude-plugin/plugin.json",
        skill_root="plugins/claude-code/skills/distilly",
        template_path="plugins/claude-code/.mcp.json.template",
    ),
    Target(
        host="codex",
        plugin_root="plugins/codex",
        plugin_manifest_path="plugins/codex/.codex-plugin/plugin.json",
        skill_root="plugins/codex/skills/distilly",
        template_path="plugins/codex/.mcp.json.template",
    ),
)


def _sha256(data: bytes) -> str:
    return "sha256_" + hashlib.sha256(data).hexdigest()


def _utf8_key(value: str) -> bytes:
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise PluginAssemblyError(f"path is not valid UTF-8: {value!r}") from error


def _canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise PluginAssemblyError("canonical JSON object keys must be strings")
        return {
            key: _canonicalize(value[key])
            for key in sorted(value, key=_utf8_key)
        }
    if isinstance(value, list):
        return [_canonicalize(item) for item in value]
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise PluginAssemblyError("canonical JSON accepts only JSON values")


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        _canonicalize(value),
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _reject_duplicate_keys(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PluginAssemblyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_symlink_ancestors(path: Path, root: Path) -> None:
    current = root
    parts = path.relative_to(root).parts
    for index, part in enumerate(parts):
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            return
        relative = current.relative_to(root).as_posix()
        if stat.S_ISLNK(mode):
            raise PluginAssemblyError(f"{relative}: symlink is forbidden")
        if index < len(parts) - 1 and not stat.S_ISDIR(mode):
            raise PluginAssemblyError(f"{relative}: expected a directory")


def _read_json(path: Path, root: Path) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    raw = _safe_regular_file(path, root)
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PluginAssemblyError(f"{relative}: invalid UTF-8 JSON: {error}") from error
    if not isinstance(value, dict):
        raise PluginAssemblyError(f"{relative}: expected a JSON object")
    return value


def _validate_relative_path(path: str, label: str) -> None:
    segments = path.split("/")
    if (
        not path
        or path.startswith("/")
        or "\\" in path
        or "\x00" in path
        or any(segment in {"", ".", ".."} for segment in segments)
    ):
        raise PluginAssemblyError(f"{label}: unsafe POSIX relative path {path!r}")
    _utf8_key(path)


def _lstat_directory(path: Path, root: Path, *, allow_missing: bool = False) -> bool:
    relative = path.relative_to(root).as_posix()
    _reject_symlink_ancestors(path, root)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        if allow_missing:
            return False
        raise PluginAssemblyError(f"{relative}: required directory is missing") from None
    if stat.S_ISLNK(mode):
        raise PluginAssemblyError(f"{relative}: symlink is forbidden")
    if not stat.S_ISDIR(mode):
        raise PluginAssemblyError(f"{relative}: expected a directory")
    return True


def _walk_regular_tree(path: Path, root: Path, *, allow_missing: bool = False) -> SkillTree:
    if not _lstat_directory(path, root, allow_missing=allow_missing):
        empty = _canonical_json([])
        return SkillTree(_sha256(b"canonical-skill-tree-v1\0" + empty), ())

    files: list[SkillFile] = []

    def walk(directory: Path) -> None:
        relative_directory = directory.relative_to(path)
        try:
            entries = list(os.scandir(directory))
        except OSError as error:
            relative = directory.relative_to(root).as_posix()
            raise PluginAssemblyError(f"{relative}: cannot scan: {error}") from error
        entries.sort(key=lambda entry: _utf8_key(entry.name))
        for entry in entries:
            child = directory / entry.name
            relative = (relative_directory / entry.name).as_posix()
            _validate_relative_path(relative, child.relative_to(root).as_posix())
            try:
                mode = entry.stat(follow_symlinks=False).st_mode
            except OSError as error:
                raise PluginAssemblyError(
                    f"{child.relative_to(root).as_posix()}: cannot stat: {error}"
                ) from error
            if stat.S_ISLNK(mode):
                raise PluginAssemblyError(
                    f"{child.relative_to(root).as_posix()}: symlink is forbidden"
                )
            if stat.S_ISDIR(mode):
                walk(child)
                continue
            if not stat.S_ISREG(mode):
                raise PluginAssemblyError(
                    f"{child.relative_to(root).as_posix()}: only regular files are allowed"
                )
            try:
                content = child.read_bytes()
            except OSError as error:
                raise PluginAssemblyError(
                    f"{child.relative_to(root).as_posix()}: cannot read: {error}"
                ) from error
            files.append(SkillFile(relative, _sha256(content), content))

    walk(path)
    files.sort(key=lambda item: _utf8_key(item.path))
    digest_input = [
        {"path": item.path, "contentDigest": item.content_digest}
        for item in files
    ]
    digest = _sha256(
        b"canonical-skill-tree-v1\0" + _canonical_json(digest_input)
    )
    return SkillTree(digest, tuple(files))


def _safe_regular_file(path: Path, root: Path) -> bytes:
    relative = path.relative_to(root).as_posix()
    _reject_symlink_ancestors(path, root)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        raise PluginAssemblyError(f"{relative}: required file is missing") from None
    if stat.S_ISLNK(mode):
        raise PluginAssemblyError(f"{relative}: symlink is forbidden")
    if not stat.S_ISREG(mode):
        raise PluginAssemblyError(f"{relative}: expected a regular file")
    return path.read_bytes()


def _component_paths(
    value: Any, key: Optional[str] = None
) -> Iterable[tuple[str, str]]:
    if isinstance(value, dict):
        for child_key, child in value.items():
            yield from _component_paths(child, child_key)
    elif isinstance(value, list):
        for child in value:
            yield from _component_paths(child, key)
    elif isinstance(value, str) and key in {"agents", "hooks", "skills"}:
        yield key, value


def _require_exact_keys(value: Mapping[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise PluginAssemblyError(f"{label}: keys must be {sorted(keys)}")


def _require_nonempty_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise PluginAssemblyError(f"{label}: must be a non-empty string")


def _validate_platform_manifest_shape(
    manifest: dict[str, Any], target: Target
) -> None:
    label = target.plugin_manifest_path
    common = {"name", "version", "description", "author", "skills"}
    if target.host == "codex":
        _require_exact_keys(manifest, common | {"interface"}, label)
    else:
        _require_exact_keys(manifest, common | {"displayName"}, label)
        _require_nonempty_string(manifest["displayName"], f"{label}:displayName")
    if manifest.get("name") != "distilly":
        raise PluginAssemblyError(f"{label}: name must be 'distilly'")
    _require_nonempty_string(manifest.get("version"), f"{label}:version")
    _require_nonempty_string(manifest.get("description"), f"{label}:description")
    if manifest.get("skills") != "./skills/":
        raise PluginAssemblyError(f"{label}: skills must be './skills/'")
    author = manifest.get("author")
    if not isinstance(author, dict):
        raise PluginAssemblyError(f"{label}: author must be an object")
    _require_exact_keys(author, {"name"}, f"{label}:author")
    _require_nonempty_string(author["name"], f"{label}:author.name")

    if target.host != "codex":
        return
    interface = manifest.get("interface")
    if not isinstance(interface, dict):
        raise PluginAssemblyError(f"{label}: interface must be an object")
    _require_exact_keys(
        interface,
        {
            "displayName",
            "shortDescription",
            "longDescription",
            "developerName",
            "category",
            "capabilities",
            "defaultPrompt",
        },
        f"{label}:interface",
    )
    for key in (
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
    ):
        _require_nonempty_string(interface[key], f"{label}:interface.{key}")
    for key in ("capabilities", "defaultPrompt"):
        values = interface[key]
        if (
            not isinstance(values, list)
            or not values
            or not all(isinstance(value, str) and value for value in values)
        ):
            raise PluginAssemblyError(
                f"{label}:interface.{key} must be a non-empty string array"
            )


def _validate_plugin_manifest(
    manifest: dict[str, Any], target: Target, release_version: str
) -> bytes:
    label = target.plugin_manifest_path
    _validate_platform_manifest_shape(manifest, target)
    for key, path in _component_paths(manifest):
        if not path.startswith("./"):
            raise PluginAssemblyError(
                f"{label}: {key} component path must begin with './'"
            )
        component_path = path[2:-1] if path.endswith("/") else path[2:]
        _validate_relative_path(component_path, f"{label}:{key}")
    serialized = json.dumps(
        {**manifest, "version": release_version},
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
    ).encode("utf-8") + b"\n"
    if SENTINEL.encode() in serialized or b".mcp.json.template" in serialized:
        raise PluginAssemblyError(f"{label}: source MCP template must not be referenced")
    return serialized


def _validate_template(path: Path, root: Path, host: str) -> None:
    raw = _safe_regular_file(path, root)
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        relative = path.relative_to(root).as_posix()
        raise PluginAssemblyError(f"{relative}: invalid UTF-8 JSON: {error}") from error
    if host == "codex":
        expected = {"distilly": {"command": SENTINEL, "args": ["mcp"]}}
    else:
        expected = {
            "mcpServers": {
                "distilly": {"command": SENTINEL, "args": ["mcp"]}
            }
        }
    if value != expected:
        relative = path.relative_to(root).as_posix()
        raise PluginAssemblyError(f"{relative}: template shape is not canonical")
    if raw.count(SENTINEL.encode()) != 1:
        relative = path.relative_to(root).as_posix()
        raise PluginAssemblyError(f"{relative}: expected exactly one launcher sentinel")


def _release_version(root: Path) -> str:
    manifest = _read_json(root / MCP_PACKAGE_MANIFEST, root)
    version = manifest.get("version")
    if not isinstance(version, str) or SEMVER.fullmatch(version) is None:
        raise PluginAssemblyError(
            f"{MCP_PACKAGE_MANIFEST}: version must be exact SemVer without a v prefix"
        )
    return version


def _validate_skill_entry(canonical: SkillTree) -> None:
    skill = next((item for item in canonical.files if item.path == "SKILL.md"), None)
    if skill is None:
        raise PluginAssemblyError(f"{CANONICAL_SKILL_ROOT}: SKILL.md is required")
    try:
        text = skill.content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PluginAssemblyError(
            f"{CANONICAL_SKILL_ROOT}/SKILL.md: must be UTF-8"
        ) from error
    lines = text.splitlines()
    try:
        closing = lines.index("---", 1)
    except ValueError:
        closing = -1
    frontmatter = lines[1:closing] if lines and lines[0] == "---" and closing > 1 else []
    keys: dict[str, str] = {}
    for line in frontmatter:
        key, separator, value = line.partition(":")
        if not separator or key in keys:
            raise PluginAssemblyError(
                f"{CANONICAL_SKILL_ROOT}/SKILL.md: invalid frontmatter"
            )
        keys[key] = value.strip()
    if set(keys) != {"name", "description"} or keys.get("name") != "distilly":
        raise PluginAssemblyError(
            f"{CANONICAL_SKILL_ROOT}/SKILL.md: frontmatter must contain only "
            "name=distilly and description"
        )
    if not keys["description"]:
        raise PluginAssemblyError(
            f"{CANONICAL_SKILL_ROOT}/SKILL.md: description must be non-empty"
        )


def _expected_outputs(root: Path) -> tuple[SkillTree, dict[str, bytes]]:
    release_version = _release_version(root)
    canonical = _walk_regular_tree(root / CANONICAL_SKILL_ROOT, root)
    _validate_skill_entry(canonical)

    outputs: dict[str, bytes] = {}
    release_targets: list[dict[str, Any]] = []
    for target in TARGETS:
        _validate_template(root / target.template_path, root, target.host)
        manifest_path = root / target.plugin_manifest_path
        manifest = _read_json(manifest_path, root)
        manifest_bytes = _validate_plugin_manifest(manifest, target, release_version)
        outputs[target.plugin_manifest_path] = manifest_bytes
        release_targets.append(
            {
                "host": target.host,
                "pluginRoot": target.plugin_root,
                "pluginManifestPath": target.plugin_manifest_path,
                "pluginManifestDigest": _sha256(manifest_bytes),
                "skillRoot": target.skill_root,
                "skillDigest": canonical.digest,
            }
        )

    release_manifest = {
        "schemaVersion": 1,
        "releaseVersion": release_version,
        "wire": {"minimumMajor": 3, "maximumMajor": 3},
        "canonicalSkill": {
            "root": CANONICAL_SKILL_ROOT,
            "digest": canonical.digest,
            "files": [
                {"path": item.path, "contentDigest": item.content_digest}
                for item in canonical.files
            ],
        },
        "targets": release_targets,
    }
    outputs[RELEASE_MANIFEST] = _canonical_json(release_manifest) + b"\n"
    if SENTINEL.encode() in outputs[RELEASE_MANIFEST]:
        raise PluginAssemblyError(
            f"{RELEASE_MANIFEST}: source MCP template must not be a release target"
        )
    return canonical, outputs


def _ensure_directory(path: Path, root: Path) -> None:
    relative_parts = path.relative_to(root).parts
    current = root
    for part in relative_parts:
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            current.mkdir()
            continue
        if stat.S_ISLNK(mode):
            raise PluginAssemblyError(
                f"{current.relative_to(root).as_posix()}: symlink is forbidden"
            )
        if not stat.S_ISDIR(mode):
            raise PluginAssemblyError(
                f"{current.relative_to(root).as_posix()}: expected a directory"
            )


def _atomic_write(path: Path, content: bytes, root: Path) -> None:
    _ensure_directory(path.parent, root)
    if path.exists() or path.is_symlink():
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise PluginAssemblyError(
                f"{path.relative_to(root).as_posix()}: symlink is forbidden"
            )
        if not stat.S_ISREG(mode):
            raise PluginAssemblyError(
                f"{path.relative_to(root).as_posix()}: expected a regular file"
            )
    temporary = path.with_name(f".{path.name}.assemble-{os.getpid()}")
    try:
        temporary.write_bytes(content)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _mirror_skill(root: Path, target_path: Path, canonical: SkillTree) -> None:
    existing = _walk_regular_tree(target_path, root, allow_missing=True)
    expected_paths = {item.path for item in canonical.files}
    if target_path.exists():
        for item in existing.files:
            if item.path not in expected_paths:
                (target_path / item.path).unlink()

    for item in canonical.files:
        _atomic_write(target_path / item.path, item.content, root)

    if target_path.exists():
        directories = [
            path
            for path in target_path.rglob("*")
            if path.is_dir() and not path.is_symlink()
        ]
        directories.sort(key=lambda path: len(path.parts), reverse=True)
        for directory in directories:
            try:
                directory.rmdir()
            except OSError:
                pass


def assemble(root: Path = ROOT) -> None:
    """Write exact plugin mirrors, manifest versions, and the release manifest."""

    root = root.resolve()
    canonical, outputs = _expected_outputs(root)
    for target in TARGETS:
        _mirror_skill(root, root / target.skill_root, canonical)
    for relative, content in outputs.items():
        _atomic_write(root / relative, content, root)

    verified = _verify_outputs(root, canonical, outputs)
    if verified:
        raise PluginAssemblyError("; ".join(verified))


def _verify_outputs(
    root: Path, canonical: SkillTree, outputs: Mapping[str, bytes]
) -> list[str]:
    errors: list[str] = []
    for target in TARGETS:
        try:
            actual = _walk_regular_tree(root / target.skill_root, root)
        except PluginAssemblyError as error:
            errors.append(str(error))
            continue
        if actual.digest != canonical.digest or tuple(
            (item.path, item.content_digest) for item in actual.files
        ) != tuple((item.path, item.content_digest) for item in canonical.files):
            errors.append(f"{target.skill_root}: does not exactly mirror the canonical skill")
    for relative, expected in outputs.items():
        path = root / relative
        try:
            actual = _safe_regular_file(path, root)
        except PluginAssemblyError as error:
            errors.append(str(error))
            continue
        if actual != expected:
            errors.append(f"{relative}: generated bytes are stale")
    return errors


def _copy_check_inputs(root: Path, destination: Path) -> None:
    (destination / "packages/mcp").mkdir(parents=True)
    shutil.copy2(root / MCP_PACKAGE_MANIFEST, destination / MCP_PACKAGE_MANIFEST)
    shutil.copytree(root / "plugins", destination / "plugins", symlinks=True)


def verify(root: Path = ROOT) -> list[str]:
    """Reassemble in a temporary root and compare every generated byte."""

    root = root.resolve()
    try:
        canonical, outputs = _expected_outputs(root)
        direct_errors = _verify_outputs(root, canonical, outputs)
        if direct_errors:
            return direct_errors
        with tempfile.TemporaryDirectory(prefix="distilly-plugin-check-") as temporary:
            check_root = Path(temporary)
            _copy_check_inputs(root, check_root)
            assemble(check_root)
            check_canonical, check_outputs = _expected_outputs(check_root)
            if check_canonical.digest != canonical.digest or check_outputs != outputs:
                return ["plugin assembly is not deterministic in a clean temporary root"]
    except (OSError, PluginAssemblyError, ValueError) as error:
        return [str(error)]
    return []


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without mutating")
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root")
    args = parser.parse_args(argv)

    if args.check:
        errors = verify(args.root)
        if errors:
            for error in errors:
                print(f"plugin assembly: {error}", file=sys.stderr)
            return 1
        print("plugin assembly: ok")
        return 0

    try:
        assemble(args.root)
    except (OSError, PluginAssemblyError, ValueError) as error:
        print(f"plugin assembly: {error}", file=sys.stderr)
        return 1
    print("plugin assembly: updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
