#!/usr/bin/env python3
"""Statically validates the optional Linux packaging recipes.

Runs without flatpak-builder, snapcraft, fpm or any third-party Python module, so it
works on a host that cannot build those formats. It verifies that:

  * every local manifest input exists, or is a staging directory that the helper
    script creates before the native tool runs;
  * the Flatpak app ID and branch are read from the manifest and used for both the
    build and the exported bundle, and the bundle file is confirmed non-empty;
  * the Snap and Flatpak versions agree with package.json;
  * the Snap primes the CA certificate paths its launcher points at;
  * build-flatpak.sh, build-snap.sh and package-linux.py map the architecture to
    electron-builder's linux-unpacked / linux-arm64-unpacked directory and reject
    unknown architectures;
  * the pacman archive keeps .PKGINFO at the archive root, using a fixture archive.

Usage:
    python3 scripts/check-package-recipes.py
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLATPAK_DIR = ROOT / "flatpak"
FLATPAK_MANIFEST = FLATPAK_DIR / "fr.fradinni.Commit87.yml"
SNAP_DIR = ROOT / "snap"
SNAP_MANIFEST = SNAP_DIR / "snapcraft.yaml"
FLATPAK_SCRIPT = ROOT / "scripts" / "build-flatpak.sh"
SNAP_SCRIPT = ROOT / "scripts" / "build-snap.sh"
LINUX_SCRIPT = ROOT / "scripts" / "package-linux.py"

# Directories produced by the helper scripts just before the native tool runs.
GENERATED_INPUTS = {"dist/flatpak-app", "dist/snap-app"}

ARCH_DIRS = {
    "x86_64": "linux-unpacked",
    "amd64": "linux-unpacked",
    "aarch64": "linux-arm64-unpacked",
    "arm64": "linux-arm64-unpacked",
}

# os.uname().machine only ever reports the GNU triplet-style names on Linux.
PYTHON_ARCH_DIRS = {"x86_64": "linux-unpacked", "aarch64": "linux-arm64-unpacked", "arm64": "linux-arm64-unpacked"}

problems: list[str] = []
checks = 0


def ok(message: str) -> None:
    global checks
    checks += 1
    print(f"ok   {message}")


def fail(message: str) -> None:
    problems.append(message)
    print(f"FAIL {message}")


def version_of_package_json() -> str:
    return json.loads((ROOT / "package.json").read_text())["version"]


def load_snap_manifest() -> tuple[dict | None, str]:
    text = SNAP_MANIFEST.read_text()
    try:
        import yaml  # noqa: PLC0415 - optional import keeps the check dependency-free
    except ImportError:
        return None, text
    try:
        return yaml.safe_load(text), text
    except yaml.YAMLError as error:
        raise SystemExit(f"snap/snapcraft.yaml is not valid YAML: {error}") from error


def relative_inside_repo(path: pathlib.Path) -> str | None:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return None


def check_local_inputs(label: str, base: pathlib.Path, values: list[str], staged_by: pathlib.Path) -> None:
    for value in values:
        if "://" in value:
            continue
        resolved = (base / value).resolve()
        relative = relative_inside_repo(resolved)
        if relative is None:
            fail(f"{label}: input {value!r} escapes the repository")
            continue
        if resolved.exists():
            ok(f"{label}: input {relative} exists")
            continue
        if relative in GENERATED_INPUTS:
            script = staged_by.read_text()
            if f'STAGE="{relative}"' in script:
                ok(f"{label}: input {relative} is staged by {staged_by.name}")
            else:
                fail(f"{label}: input {relative} is neither checked in nor staged by {staged_by.name}")
            continue
        fail(f"{label}: input {relative} does not exist")


def check_versions() -> None:
    version = version_of_package_json()
    data, text = load_snap_manifest()
    if data is not None:
        snap_version = str(data.get("version", ""))
    else:
        match = re.search(r"(?m)^version:\s*['\"]?([^'\"\s]+)", text)
        snap_version = match.group(1) if match else ""
    if snap_version == version:
        ok(f"version: snapcraft.yaml matches package.json ({version})")
    else:
        fail(f"version: snapcraft.yaml has {snap_version!r}, package.json has {version!r}")

    metainfo = (FLATPAK_DIR / "fr.fradinni.Commit87.metainfo.xml").read_text()
    release = re.search(r'<release version="([^"]+)"', metainfo)
    metainfo_version = release.group(1) if release else ""
    if metainfo_version == version:
        ok(f"version: Flatpak metainfo matches package.json ({version})")
    else:
        fail(f"version: Flatpak metainfo has {metainfo_version!r}, package.json has {version!r}")


def check_flatpak_manifest() -> None:
    manifest = FLATPAK_MANIFEST.read_text()
    app_id = re.search(r"(?m)^app-id:\s*([^#\s]+)", manifest)
    branch = re.search(r"(?m)^branch:\s*([^#\s]+)", manifest)
    if not app_id or not branch:
        fail("flatpak: manifest must declare app-id and branch")
        return
    ok(f"flatpak: manifest declares app-id {app_id.group(1)} on branch {branch.group(1)}")

    script = FLATPAK_SCRIPT.read_text()
    for literal in (app_id.group(1), branch.group(1)):
        if re.search(rf"[\"']{re.escape(literal)}[\"']", script):
            fail(f"flatpak: {FLATPAK_SCRIPT.name} hard-codes {literal!r} instead of reading the manifest")
    for expected, description in (
        ("manifest_value app-id", "reads the app ID from the manifest"),
        ("manifest_value branch", "reads the branch from the manifest"),
        ('--default-branch="$BRANCH"', "builds the manifest branch"),
        ('build-bundle --arch="$FLATPAK_ARCH"', "exports the architecture it built"),
        ('"$APP_ID" "$BRANCH"', "exports the same app ID and branch it built"),
        ('[ ! -s "$BUNDLE" ]', "checks that the exported bundle file exists"),
    ):
        if expected in script:
            ok(f"flatpak: script {description}")
        else:
            fail(f"flatpak: script does not {description}")

    paths = re.findall(r"(?m)^\s*-?\s*path:\s*(\S+)\s*$", manifest)
    check_local_inputs("flatpak", FLATPAK_DIR, paths, FLATPAK_SCRIPT)

    icons = sorted(set(re.findall(r"icons/([0-9]+x[0-9]+\.png)", manifest)))
    if not icons:
        fail("flatpak: manifest installs no hicolor icons")
    for icon in icons:
        if (ROOT / "build" / "icons" / icon).is_file():
            ok(f"flatpak: icon build/icons/{icon} exists")
        else:
            fail(f"flatpak: icon build/icons/{icon} is missing")


def check_snap_manifest() -> None:
    data, text = load_snap_manifest()
    if data is not None:
        sources = [str(part.get("source", "")) for part in data.get("parts", {}).values()]
        sources = [source for source in sources if source]
        icon = str(data.get("icon", ""))
        prime = data.get("parts", {}).get("commit87", {}).get("prime", [])
    else:
        sources = re.findall(r"(?m)^\s+source:\s*(\S+)\s*$", text)
        icon_match = re.search(r"(?m)^icon:\s*(\S+)\s*$", text)
        icon = icon_match.group(1) if icon_match else ""
        prime = []
        in_prime = False
        for line in text.splitlines():
            if re.match(r"^\s+prime:\s*$", line):
                in_prime = True
                continue
            if in_prime:
                if line.startswith("      - "):
                    prime.append(line.strip()[2:].strip())
                elif line.strip() and not line.startswith("      "):
                    in_prime = False
    ok(f"snap: parsed {SNAP_MANIFEST.relative_to(ROOT)} with {len(sources)} part sources")

    check_local_inputs("snap", ROOT, sources, SNAP_SCRIPT)

    icon_path = ROOT / icon
    if icon and icon_path.is_file():
        ok(f"snap: icon {icon} exists")
    else:
        fail(f"snap: icon {icon!r} does not resolve to a file in the repository")

    required_prime = {"etc/ssl/certs", "usr/lib/ssl", "usr/share/ca-certificates"}
    missing = sorted(required_prime - set(prime))
    if missing:
        fail(f"snap: prime list omits certificate paths {missing}")
    else:
        ok("snap: prime list includes the CA certificate paths the launcher uses")

    launcher = (SNAP_DIR / "local" / "command.sh").read_text()
    if "GIT_SSL_CAINFO=\"${SNAP}/etc/ssl/certs/ca-certificates.crt\"" in launcher:
        ok("snap: launcher points GIT_SSL_CAINFO at the primed certificate bundle")
    else:
        fail("snap: launcher no longer points GIT_SSL_CAINFO at etc/ssl/certs")

    script = SNAP_SCRIPT.read_text()
    if 'STAGE="dist/snap-app"' in script:
        ok("snap: script stages the arch-specific unpacked app at dist/snap-app")
    else:
        fail("snap: script does not stage dist/snap-app")
    if "sed -i" in script:
        fail("snap: build-snap.sh rewrites the tracked snapcraft.yaml instead of reading its version")
    else:
        ok("snap: build-snap.sh leaves the tracked manifest untouched")


def extract_shell_function(source: str, name: str) -> str:
    match = re.search(rf"(?ms)^{re.escape(name)}\(\) \{{\n.*?^\}}", source)
    return match.group(0) if match else ""


def check_shell_arch_function(script: pathlib.Path) -> None:
    source = script.read_text()
    body = extract_shell_function(source, "unpacked_dir_for")
    if not body:
        fail(f"arch: {script.name} has no unpacked_dir_for function")
        return
    probe = (
        body
        + "\n"
        + 'for arch in x86_64 amd64 aarch64 arm64; do\n'
        + "  printf '%s\\n' \"$(unpacked_dir_for \"$arch\")\"\n"
        + "done\n"
        + "if unpacked_dir_for riscv64 >/dev/null 2>&1; then echo unknown-accepted; fi\n"
    )
    try:
        result = subprocess.run(["bash", "-c", probe], check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"arch: cannot evaluate unpacked_dir_for from {script.name}: {error}")
        return
    lines = result.stdout.splitlines()
    expected = [ARCH_DIRS["x86_64"], ARCH_DIRS["amd64"], ARCH_DIRS["aarch64"], ARCH_DIRS["arm64"]]
    if lines == expected:
        ok(f"arch: {script.name} derives {expected[0]} / {expected[2]} from the machine name")
    else:
        fail(f"arch: {script.name} derives {lines!r}, expected {expected!r}")
    if "unknown-accepted" in lines:
        fail(f"arch: {script.name} accepts an unknown architecture")
    if '[ ! -d "$APP_DIR" ]' in source:
        ok(f"arch: {script.name} fails when the derived unpacked directory is missing")
    else:
        fail(f"arch: {script.name} does not check the derived unpacked directory")
    if 'cp -al "$APP_DIR" "$STAGE"' in source:
        ok(f"arch: {script.name} stages the directory it derived")
    else:
        fail(f"arch: {script.name} does not stage the derived directory")


def load_linux_script():
    spec = importlib.util.spec_from_file_location("commit87_package_linux", LINUX_SCRIPT)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import {LINUX_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_python_arch(module) -> None:
    for machine, directory in PYTHON_ARCH_DIRS.items():
        actual = module.unpacked_dir(machine).name
        if actual == directory:
            ok(f"arch: package-linux.py maps {machine} to {directory}")
        else:
            fail(f"arch: package-linux.py maps {machine} to {actual!r}, expected {directory!r}")
    source = LINUX_SCRIPT.read_text()
    if "APP_DIR = unpacked_dir(machine)" in source:
        ok("arch: package-linux.py resolves APP_DIR from the host machine")
    else:
        fail("arch: package-linux.py does not resolve APP_DIR from the host machine")
    if 'APP_DIR = DIST / "linux-unpacked"' in source:
        fail("arch: package-linux.py still hard-codes linux-unpacked")


def tar_zstd_available() -> bool:
    try:
        return (
            subprocess.run(
                ["tar", "--zstd", "-cf", "/dev/null", "-T", "/dev/null"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        )
    except OSError:
        return False


def check_pacman_layout(module) -> None:
    for attribute in ("pacman_archive", "pacman_archive_entries", "assert_pacman_layout"):
        if not hasattr(module, attribute):
            fail(f"pacman: package-linux.py has no {attribute}()")
            return
    if "assert_pacman_layout(out)" not in LINUX_SCRIPT.read_text():
        fail("pacman: build_pacman does not validate the produced archive")
    if not tar_zstd_available():
        print("skip pacman archive fixture: this tar has no --zstd support")
        return

    with tempfile.TemporaryDirectory() as temporary:
        base = pathlib.Path(temporary)
        pkgdir = base / "pkg"
        (pkgdir / "usr" / "bin").mkdir(parents=True)
        (pkgdir / "usr" / "share" / "applications").mkdir(parents=True)
        (pkgdir / ".PKGINFO").write_text("pkgname = commit87\n")
        (pkgdir / ".INSTALL").write_text("post_install() { :; }\n")
        (pkgdir / "usr" / "bin" / "commit87").write_text("")
        (pkgdir / "usr" / "share" / "applications" / "commit87.desktop").write_text("[Desktop Entry]\n")
        archive = base / "fixture.pkg.tar.zst"
        module.pacman_archive(archive, pkgdir)
        entries = module.pacman_archive_entries(archive)
        if entries and entries[0] == ".PKGINFO" and "usr/bin/commit87" in entries:
            ok("pacman: fixture archive keeps .PKGINFO at the archive root")
        else:
            fail(f"pacman: fixture archive layout is wrong: {entries[:4]}")
        try:
            module.assert_pacman_layout(archive)
        except SystemExit:
            fail("pacman: validator rejects the correct archive root")
        else:
            ok("pacman: validator accepts .PKGINFO at the archive root")

        nested_parent = base / "nested"
        nested_parent.mkdir()
        nested_pkg = nested_parent / "commit87"
        nested_pkg.mkdir()
        (nested_pkg / ".PKGINFO").write_text("pkgname = commit87\n")
        (nested_pkg / "usr").mkdir()
        nested_archive = base / "nested.pkg.tar.zst"
        subprocess.run(
            ["tar", "--zstd", "-cf", str(nested_archive), "-C", str(nested_parent), "commit87"],
            check=True,
        )
        try:
            module.assert_pacman_layout(nested_archive)
        except SystemExit:
            ok("pacman: validator rejects an archive that nests .PKGINFO below the root")
        else:
            fail("pacman: validator accepts an archive that nests .PKGINFO below the root")


def check_shell_syntax() -> None:
    for script in (FLATPAK_SCRIPT, SNAP_SCRIPT, SNAP_DIR / "local" / "command.sh", FLATPAK_DIR / "commit87.sh"):
        result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        if result.returncode == 0:
            ok(f"syntax: bash -n {script.relative_to(ROOT)}")
        else:
            fail(f"syntax: {script.relative_to(ROOT)}: {result.stderr.strip()}")


def main() -> int:
    check_shell_syntax()
    check_versions()
    check_flatpak_manifest()
    check_snap_manifest()
    check_shell_arch_function(FLATPAK_SCRIPT)
    check_shell_arch_function(SNAP_SCRIPT)
    module = load_linux_script()
    check_python_arch(module)
    check_pacman_layout(module)

    print()
    if problems:
        print(f"{len(problems)} problem(s) found in the optional package recipes:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"all {checks} recipe checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
