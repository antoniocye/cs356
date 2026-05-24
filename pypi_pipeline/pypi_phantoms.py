#!/usr/bin/env python3
"""Conservative PyPI phantom-dependency collector.

This script is intentionally dependency-light so it can run from a clean clone.
It is not a full packaging resolver; it is a reproducible static-analysis
collector for the PyPI side of the paper.
"""

from __future__ import annotations

import argparse
import ast
import concurrent.futures
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
import warnings
from pathlib import Path
from typing import Iterable


KNOWN_IMPORT_TO_PACKAGE = {
    "PIL": "pillow",
    "bs4": "beautifulsoup4",
    "cv2": "opencv-python",
    "sklearn": "scikit-learn",
    "yaml": "pyyaml",
    "Crypto": "pycryptodome",
    "OpenSSL": "pyopenssl",
    "dateutil": "python-dateutil",
    "grpc": "grpcio",
    "jwt": "pyjwt",
    "google": "google",
    "azure": "azure",
}

IGNORE_DIRS = {
    ".git",
    ".hg",
    ".tox",
    ".venv",
    "venv",
    "env",
    "build",
    "dist",
    "__pycache__",
    "site-packages",
    "tests",
    "test",
    "docs",
    "examples",
    "example",
    "scripts",
    "script",
    "tools",
    "tool",
    "ci",
    ".github",
    "benchmarks",
    "benchmark",
    "notebooks",
    "dev",
    "testing",
    "stubs",
    "typeshed",
}

IGNORE_FILENAMES = {
    "setup.py",
    "conftest.py",
    "noxfile.py",
    "toxfile.py",
    "tasks.py",
    "fabfile.py",
}

LEGACY_STDLIB_IMPORTS = {"distutils", "stringio", "test", "tests"}
MAX_AST_FILE_BYTES = 250_000
MAX_AST_FILES_PER_REPO = 1500


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def normalize_import(module: str) -> str:
    root = module.split(".", 1)[0]
    if root.startswith("_"):
        return ""
    return normalize_name(KNOWN_IMPORT_TO_PACKAGE.get(root, root))


def fetch_json(url: str, retries: int = 3) -> dict | None:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(attempt)
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def normalize_repo_url(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip().replace("git+", "").split("#", 1)[0]
    if value.startswith("git://github.com/"):
        value = "https://" + value[len("git://") :]
    if value.startswith("git@github.com:"):
        value = "https://github.com/" + value[len("git@github.com:") :]
    if value.startswith("http://github.com/"):
        value = "https://" + value[len("http://") :]
    if not value.startswith("https://github.com/"):
        return None
    value = value.rstrip("/")
    if value.endswith(".git"):
        value = value[:-4]
    parts = value.split("/")
    if len(parts) < 5:
        return None
    return "/".join(parts[:5])


def repo_url_for_package(package_name: str) -> str | None:
    data = fetch_json(f"https://pypi.org/pypi/{package_name}/json")
    if not data:
        return None
    info = data.get("info") or {}
    candidates: list[str] = []
    for key in ("project_urls", "project_url"):
        urls = info.get(key)
        if isinstance(urls, dict):
            candidates.extend(str(value) for value in urls.values())
    for key in ("home_page", "download_url", "package_url"):
        if info.get(key):
            candidates.append(str(info[key]))
    for candidate in candidates:
        normalized = normalize_repo_url(candidate)
        if normalized:
            return normalized
    return None


def clone_repo(repo_url: str, destination: Path, timeout_seconds: int) -> bool:
    try:
        subprocess.run(
            ["git", "clone", "--depth=1", repo_url, str(destination)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=timeout_seconds,
        )
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def requirement_name(requirement: str) -> str | None:
    requirement = requirement.strip()
    if not requirement or requirement.startswith("#") or requirement.startswith("-"):
        return None
    requirement = requirement.split(";", 1)[0].strip()
    match = re.match(r"([A-Za-z0-9_.-]+)", requirement)
    return normalize_name(match.group(1)) if match else None


def declared_from_pyproject(path: Path) -> set[str]:
    declared: set[str] = set()
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return declared

    project = data.get("project") or {}
    for req in project.get("dependencies") or []:
        name = requirement_name(str(req))
        if name:
            declared.add(name)
    for reqs in (project.get("optional-dependencies") or {}).values():
        for req in reqs:
            name = requirement_name(str(req))
            if name:
                declared.add(name)

    poetry = (((data.get("tool") or {}).get("poetry") or {}).get("dependencies") or {})
    for name in poetry:
        if name.lower() != "python":
            declared.add(normalize_name(name))
    return declared


def declared_from_requirements(path: Path) -> set[str]:
    declared: set[str] = set()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        lines = path.read_text(errors="ignore").splitlines()
    for line in lines:
        name = requirement_name(line)
        if name:
            declared.add(name)
    return declared


def declared_dependencies(repo: Path) -> set[str]:
    declared: set[str] = set()
    for path in repo.rglob("*"):
        if any(part in IGNORE_DIRS for part in path.parts):
            continue
        if path.name.lower() in IGNORE_FILENAMES:
            continue
        lower = path.name.lower()
        if lower == "pyproject.toml":
            declared |= declared_from_pyproject(path)
        elif lower.startswith("requirements") and lower.endswith(".txt"):
            declared |= declared_from_requirements(path)
    return declared


def local_module_names(repo: Path) -> set[str]:
    local: set[str] = set()
    for child in repo.rglob("*"):
        if any(part in IGNORE_DIRS for part in child.parts):
            continue
        if child.is_file() and child.suffix == ".py":
            local.add(normalize_import(child.stem))
        elif child.is_dir() and (child / "__init__.py").exists():
            local.add(normalize_import(child.name))
    return local


def iter_python_files(repo: Path) -> Iterable[Path]:
    yielded = 0
    for path in repo.rglob("*.py"):
        if any(part in IGNORE_DIRS for part in path.parts):
            continue
        try:
            if path.stat().st_size > MAX_AST_FILE_BYTES:
                continue
        except OSError:
            continue
        if yielded >= MAX_AST_FILES_PER_REPO:
            return
        yielded += 1
        yield path


def imported_packages(repo: Path) -> set[str]:
    imports: set[str] = set()
    stdlib = set(getattr(sys, "stdlib_module_names", set()))
    for path in iter_python_files(repo):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".", 1)[0]
                    normalized = normalize_import(root)
                    if normalized and root not in stdlib and normalized not in LEGACY_STDLIB_IMPORTS:
                        imports.add(normalized)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                root = node.module.split(".", 1)[0]
                normalized = normalize_import(root)
                if normalized and root not in stdlib and normalized not in LEGACY_STDLIB_IMPORTS:
                    imports.add(normalized)
    return imports


def analyze_package(row: dict, work_root: Path, clone_timeout: int) -> dict:
    package_name = row.get("package_name") or row.get("name")
    if not package_name:
        return {**row, "status": "missing_package_name", "phantom_count": 0, "phantom_deps": ""}

    repo_url = repo_url_for_package(package_name)
    if not repo_url:
        return {**row, "status": "no_repo", "repo_url": "", "phantom_count": 0, "phantom_deps": ""}

    repo_dir = work_root / normalize_name(package_name)
    try:
        if repo_dir.exists():
            shutil.rmtree(repo_dir)
        if not clone_repo(repo_url, repo_dir, clone_timeout):
            return {**row, "status": "clone_failed", "repo_url": repo_url, "phantom_count": 0, "phantom_deps": ""}

        declared = declared_dependencies(repo_dir)
        imports = imported_packages(repo_dir)
        local = local_module_names(repo_dir)
        local.add(normalize_import(package_name.replace("-", "_")))
        phantoms = sorted(imports - declared - local)

        return {
            **row,
            "status": "success",
            "repo_url": repo_url,
            "phantom_count": len(phantoms),
            "phantom_deps": ",".join(phantoms),
            "total_imports": len(imports),
            "total_declared": len(declared),
        }
    finally:
        shutil.rmtree(repo_dir, ignore_errors=True)


def read_input(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write_output(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda row: int(row.get("rank") or 10**9))
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/pypi/top1000.csv")
    parser.add_argument("--out", default="results/pypi-collected.csv")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--clone-timeout", type=int, default=75)
    args = parser.parse_args()

    rows = read_input(Path(args.input))
    if args.limit:
        rows = rows[: args.limit]

    existing: list[dict] = []
    if args.resume and Path(args.out).exists():
        existing = read_input(Path(args.out))
        done = {row.get("package_name") or row.get("name") for row in existing}
        rows = [row for row in rows if (row.get("package_name") or row.get("name")) not in done]
        print(f"resume: {len(existing)} existing rows, {len(rows)} remaining", file=sys.stderr)

    with tempfile.TemporaryDirectory(prefix="pypi-phantoms-") as temp_dir:
        work_root = Path(temp_dir)
        results: list[dict] = existing[:]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            future_to_package = {
                pool.submit(analyze_package, row, work_root, args.clone_timeout): row.get("package_name") or row.get("name")
                for row in rows
            }
            for index, future in enumerate(concurrent.futures.as_completed(future_to_package), start=1):
                package = future_to_package[future]
                try:
                    results.append(future.result())
                except Exception as error:
                    results.append({"package_name": package, "status": "error", "error": str(error)})
                if index % 25 == 0:
                    print(f"processed {index}/{len(rows)}", file=sys.stderr)
                    write_output(Path(args.out), results)

        write_output(Path(args.out), results)


if __name__ == "__main__":
    main()
