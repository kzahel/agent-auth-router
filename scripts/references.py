#!/usr/bin/env python3
"""Synchronize and validate agent-auth-router's local reference repositories.

Adapted from RSTorrent's scripts/references.py (same author, MIT), with an
added read-only ``upstream`` command that reports how far each pinned
checkout is behind its upstream default branch.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parent.parent
REFERENCE_ROOT = ROOT / "reference"
MANIFEST_PATH = REFERENCE_ROOT / "pins.toml"
REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")
BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


class ReferenceError(Exception):
    """A reference checkout is invalid or cannot be synchronized safely."""


@dataclass(frozen=True)
class Reference:
    kind: str
    name: str
    path: str
    repository: str
    purpose: str
    required: bool
    revision: str | None
    branch: str | None
    submodules: bool

    @property
    def absolute_path(self) -> Path:
        return (ROOT / self.path).resolve()


def fail(message: str) -> NoReturn:
    raise ReferenceError(message)


def require_string(record: dict[str, Any], key: str, context: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value:
        fail(f"{context} is missing non-empty string {key!r}")
    return value


def parse_records(kind: str, raw_records: Any) -> list[Reference]:
    if not isinstance(raw_records, list):
        fail(f"manifest field {kind!r} must be an array of tables")

    records: list[Reference] = []
    for index, raw in enumerate(raw_records, start=1):
        context = f"{kind} record {index}"
        if not isinstance(raw, dict):
            fail(f"{context} must be a table")

        revision = raw.get("revision")
        branch = raw.get("branch")
        if (revision is None) == (branch is None):
            fail(f"{context} must declare exactly one of revision or branch")
        if revision is not None and (
            not isinstance(revision, str) or not REVISION_PATTERN.fullmatch(revision)
        ):
            fail(f"{context} revision must be a full lowercase Git commit")
        if branch is not None and (
            not isinstance(branch, str) or not BRANCH_PATTERN.fullmatch(branch)
        ):
            fail(f"{context} branch is invalid")
        if kind == "checkout" and branch is not None:
            fail(f"{context} must use an exact revision")

        required = raw.get("required", True)
        submodules = raw.get("submodules", False)
        if not isinstance(required, bool):
            fail(f"{context} required must be a boolean")
        if not isinstance(submodules, bool):
            fail(f"{context} submodules must be a boolean")

        records.append(
            Reference(
                kind=kind,
                name=require_string(raw, "name", context),
                path=require_string(raw, "path", context),
                repository=require_string(raw, "repository", context),
                purpose=require_string(raw, "purpose", context),
                required=required,
                revision=revision,
                branch=branch,
                submodules=submodules,
            )
        )
    return records


def read_manifest() -> list[Reference]:
    try:
        with MANIFEST_PATH.open("rb") as manifest_file:
            manifest = tomllib.load(manifest_file)
    except (OSError, tomllib.TOMLDecodeError) as error:
        fail(f"cannot read {MANIFEST_PATH.relative_to(ROOT)}: {error}")

    if manifest.get("schema_version") != 1:
        fail("pins.toml schema_version must be 1")

    records = parse_records("checkout", manifest.get("checkout", []))
    records.extend(parse_records("sibling", manifest.get("sibling", [])))

    names: set[str] = set()
    paths: set[Path] = set()
    for record in records:
        if record.name in names:
            fail(f"duplicate reference name {record.name!r}")
        names.add(record.name)

        path = record.absolute_path
        if path in paths:
            fail(f"duplicate reference path {record.path!r}")
        paths.add(path)

        if record.kind == "checkout" and not path.is_relative_to(REFERENCE_ROOT.resolve()):
            fail(f"{record.name} checkout must remain below reference/")

    return records


def run_git(
    arguments: list[str],
    *,
    cwd: Path = ROOT,
    check: bool = True,
    capture: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        suffix = f": {detail}" if detail else ""
        fail(f"git {' '.join(arguments)} failed{suffix}")
    return result


def git_at(
    record: Reference,
    arguments: list[str],
    *,
    check: bool = True,
    capture: bool = True,
) -> subprocess.CompletedProcess[str]:
    return run_git(
        ["-C", str(record.absolute_path), *arguments],
        check=check,
        capture=capture,
    )


def output_at(record: Reference, arguments: list[str]) -> str:
    return git_at(record, arguments).stdout.strip()


def normalized_remote(remote: str) -> str:
    return remote.strip().rstrip("/").removesuffix(".git")


def ensure_repository_root(record: Reference) -> None:
    probe = git_at(record, ["rev-parse", "--show-toplevel"], check=False)
    if probe.returncode != 0:
        fail(f"{record.path} exists but is not a Git repository")
    if Path(probe.stdout.strip()).resolve() != record.absolute_path:
        fail(f"{record.path} is not the root of its own Git repository")


def ensure_origin(record: Reference) -> None:
    remote = git_at(record, ["remote", "get-url", "origin"], check=False)
    if remote.returncode != 0:
        fail(f"{record.path} has no origin remote")
    actual = remote.stdout.strip()
    if normalized_remote(actual) != normalized_remote(record.repository):
        fail(f"{record.path} origin is {actual!r}; expected {record.repository!r}")


def dirty_paths(record: Reference) -> list[str]:
    output = output_at(
        record,
        ["status", "--porcelain=v1", "--untracked-files=all"],
    )
    if not output:
        return []
    return [line[3:].split(" -> ")[-1] for line in output.splitlines()]


def ensure_clean(record: Reference) -> None:
    dirty = dirty_paths(record)
    if dirty:
        fail(
            f"{record.path} has local changes; refusing to update: "
            + ", ".join(dirty)
        )


def repository_problem(record: Reference) -> str | None:
    if not record.absolute_path.exists():
        return None if not record.required else "missing"

    probe = git_at(record, ["rev-parse", "--show-toplevel"], check=False)
    if probe.returncode != 0:
        return "not a Git repository"
    if Path(probe.stdout.strip()).resolve() != record.absolute_path:
        return "not the root of its own Git repository"

    remote = git_at(record, ["remote", "get-url", "origin"], check=False)
    if remote.returncode != 0:
        return "has no origin remote"
    actual_remote = remote.stdout.strip()
    if normalized_remote(actual_remote) != normalized_remote(record.repository):
        return f"origin is {actual_remote!r}; expected {record.repository!r}"

    head = output_at(record, ["rev-parse", "HEAD"])
    if record.revision is not None and head != record.revision:
        return f"HEAD is {head}; expected {record.revision}"

    if record.branch is not None:
        branch = git_at(
            record,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            check=False,
        )
        if branch.returncode != 0 or branch.stdout.strip() != record.branch:
            return f"is not on tracking branch {record.branch}"

        remote_revision = git_at(
            record,
            ["rev-parse", f"refs/remotes/origin/{record.branch}"],
            check=False,
        )
        if remote_revision.returncode != 0:
            return (
                f"has no local origin/{record.branch} ref; "
                "run references.py sync"
            )
        if head != remote_revision.stdout.strip():
            return (
                f"HEAD is {head}; local origin/{record.branch} is "
                f"{remote_revision.stdout.strip()}; run references.py sync"
            )

    dirty = dirty_paths(record)
    if dirty:
        return "has working-tree changes: " + ", ".join(dirty)
    return None


def status(records: list[Reference]) -> None:
    problems = False
    for record in records:
        problem = repository_problem(record)
        if problem:
            print(f"[fail] {record.name}: {problem}", file=sys.stderr)
            problems = True
            continue

        if not record.absolute_path.exists():
            print(f"[skip] {record.name}: optional checkout is missing")
            continue

        identity = record.revision
        if identity is None:
            identity = f"{record.branch}@{output_at(record, ['rev-parse', 'HEAD'])}"
        print(f"[ok]   {record.name}: {identity}")

    if problems:
        fail("one or more reference checkouts are invalid")


def sync_checkout(record: Reference) -> None:
    cloned = False
    if not record.absolute_path.exists():
        record.absolute_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"[clone] {record.name} -> {record.path}")
        run_git(
            [
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                record.repository,
                str(record.absolute_path),
            ],
            capture=False,
        )
        cloned = True
    else:
        ensure_repository_root(record)
        ensure_origin(record)
        ensure_clean(record)

    ensure_repository_root(record)
    ensure_origin(record)
    assert record.revision is not None

    object_probe = git_at(
        record,
        ["cat-file", "-e", f"{record.revision}^{{commit}}"],
        check=False,
    )
    if object_probe.returncode != 0:
        print(f"[fetch] {record.name} {record.revision}")
        git_at(
            record,
            ["fetch", "--filter=blob:none", "origin", record.revision],
            capture=False,
        )

    head = git_at(record, ["rev-parse", "HEAD"], check=False)
    if cloned or head.returncode != 0 or head.stdout.strip() != record.revision:
        print(f"[pin]   {record.name} {record.revision}")
        git_at(
            record,
            ["checkout", "--detach", record.revision],
            capture=False,
        )

    if record.submodules:
        print(f"[sync]  {record.name} submodules")
        git_at(
            record,
            ["submodule", "update", "--init", "--recursive"],
            capture=False,
        )


def sync_sibling(record: Reference) -> None:
    assert record.branch is not None
    if not record.absolute_path.exists():
        record.absolute_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"[clone] {record.name} -> {record.path} ({record.branch})")
        run_git(
            [
                "clone",
                "--filter=blob:none",
                "--single-branch",
                "--branch",
                record.branch,
                record.repository,
                str(record.absolute_path),
            ],
            capture=False,
        )

    ensure_repository_root(record)
    ensure_origin(record)
    ensure_clean(record)

    current_branch = git_at(
        record,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        check=False,
    )
    if current_branch.returncode != 0 or current_branch.stdout.strip() != record.branch:
        fail(
            f"{record.path} must already be on {record.branch}; "
            "refusing to replace its current checkout"
        )

    print(f"[fetch] {record.name} origin/{record.branch}")
    git_at(
        record,
        ["fetch", "--prune", "origin", record.branch],
        capture=False,
    )
    head = output_at(record, ["rev-parse", "HEAD"])
    remote_head = output_at(
        record,
        ["rev-parse", f"refs/remotes/origin/{record.branch}"],
    )
    if head == remote_head:
        return

    ancestor = git_at(
        record,
        ["merge-base", "--is-ancestor", head, remote_head],
        check=False,
    )
    if ancestor.returncode != 0:
        fail(
            f"{record.path} cannot fast-forward cleanly from {head} "
            f"to origin/{record.branch} at {remote_head}"
        )

    print(f"[update] {record.name} {head} -> {remote_head}")
    git_at(
        record,
        ["merge", "--ff-only", f"origin/{record.branch}"],
        capture=False,
    )


def sync(records: list[Reference]) -> None:
    for record in records:
        if record.kind == "checkout":
            sync_checkout(record)
        else:
            sync_sibling(record)
    status(records)


def upstream(records: list[Reference]) -> None:
    """Report how far each pin trails its upstream default branch.

    Read-only for working trees: it may fetch objects into a checkout, but it
    never moves a pin. Bumping a pin is a reviewed edit to pins.toml.
    """
    for record in records:
        if record.kind != "checkout":
            print(f"[skip] {record.name}: tracks {record.branch}; sync fast-forwards it")
            continue
        remote = run_git(["ls-remote", "--symref", record.repository, "HEAD"])
        lines = remote.stdout.splitlines()
        branch = next((line.split()[1].removeprefix("refs/heads/") for line in lines if line.startswith("ref:")), "HEAD")
        head = next((line.split()[0] for line in lines if not line.startswith("ref:")), "")
        if head == record.revision:
            print(f"[ok]   {record.name}: pin is the head of {branch}")
            continue
        if not record.absolute_path.exists():
            print(f"[new]  {record.name}: {branch} is at {head}; run sync to count commits since the pin")
            continue
        ensure_repository_root(record)
        ensure_origin(record)
        git_at(record, ["fetch", "--filter=blob:none", "origin", branch])
        behind = output_at(record, ["rev-list", "--count", f"{record.revision}..FETCH_HEAD"])
        pinned = output_at(record, ["show", "-s", "--format=%cs", record.revision])
        latest = output_at(record, ["show", "-s", "--format=%cs", "FETCH_HEAD"])
        print(f"[behind] {record.name}: {behind} commits on {branch} since the pin ({pinned} -> {latest}, head {head})")


def select_records(records: list[Reference], names: list[str]) -> list[Reference]:
    """Return manifest-ordered records selected by unique command-line names."""
    if not names:
        return records

    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        fail("duplicate --only reference name(s): " + ", ".join(duplicates))

    requested = set(names)
    known = {record.name for record in records}
    unknown = sorted(requested - known)
    if unknown:
        fail("unknown --only reference name(s): " + ", ".join(unknown))

    return [record for record in records if record.name in requested]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Synchronize or validate local reference repositories.",
    )
    parser.add_argument(
        "command",
        choices=("sync", "status", "upstream"),
        help="clone/update references, validate them, or report how far pins trail upstream",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="NAME",
        help="operate on one named manifest record; may be repeated",
    )
    return parser.parse_args()


def main() -> int:
    try:
        records = read_manifest()
        arguments = parse_args()
        records = select_records(records, arguments.only)
        command = arguments.command
        if command == "sync":
            sync(records)
        elif command == "upstream":
            upstream(records)
        else:
            status(records)
        return 0
    except ReferenceError as error:
        print(f"reference error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
