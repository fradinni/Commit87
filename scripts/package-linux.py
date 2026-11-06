#!/usr/bin/env python3
"""Builds .deb, .rpm and .pkg.tar.zst packages from dist/linux-unpacked.

This is the fallback for build hosts where electron-builder's bundled fpm
cannot run (for example Fedora without libcrypt.so.1). CI uses electron-builder
directly, which produces the same layouts.

Usage:
    python3 scripts/package-linux.py            # all formats for the host arch
    python3 scripts/package-linux.py deb rpm
"""
from __future__ import annotations

import gzip
import hashlib
import io
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP_DIR = DIST / "linux-unpacked"
ICONS = ROOT / "build" / "icons"
PKG_NAME = "commit87"
DISPLAY_NAME = "Commit87"
VERSION = os.environ.get("COMMIT87_VERSION") or __import__("json").loads((ROOT / "package.json").read_text())["version"]
INSTALL_DIR = "/opt/Commit87"
MAINTAINER = "Commit87 Team <contact@fradinni.fr>"
HOMEPAGE = "https://commit87.fradinni.fr"
DESCRIPTION = (
    "Commit87 is a fast desktop Git client built on the system Git binary. It manages "
    "repositories, branches, worktrees, tags, releases and pipelines, with multi-account "
    "identity support for GitHub, GitLab, Bitbucket and Gitea."
)
SUMMARY = "A focused desktop Git client"
LICENSE = "MIT"

ARCH_MAP = {
    "x86_64": {"deb": "amd64", "rpm": "x86_64", "pacman": "x86_64"},
    "aarch64": {"deb": "arm64", "rpm": "aarch64", "pacman": "aarch64"},
    "arm64": {"deb": "arm64", "rpm": "aarch64", "pacman": "aarch64"},
}

DEB_DEPENDS = "git, libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libsecret-1-0"
RPM_REQUIRES = ["git", "gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "at-spi2-core", "libsecret"]
PACMAN_DEPENDS = ["git", "gtk3", "libnotify", "nss", "libxss", "libxtst", "xdg-utils", "at-spi2-core", "libsecret"]

DESKTOP = """[Desktop Entry]
Name=Commit87
GenericName=Git Client
Comment=Manage repositories, branches, worktrees, releases and pipelines
Exec=commit87 %U
Icon=commit87
Terminal=false
Type=Application
Categories=Development;RevisionControl;
Keywords=git;scm;version control;repository;branch;worktree;
StartupWMClass=Commit87
StartupNotify=true
MimeType=x-scheme-handler/commit87;
"""

WRAPPER = """#!/bin/sh
exec /opt/Commit87/commit87 "$@"
"""


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wrap_description(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= width:
            current += " " + word
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def installed_size_kb() -> int:
    total = 0
    for path in APP_DIR.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    return max(1, total // 1024)


def tree_entries() -> list[tuple[str, pathlib.Path, int]]:
    """(destination path in the package, source path, mode)."""
    entries: list[tuple[str, pathlib.Path, int]] = []
    for path in sorted(APP_DIR.rglob("*")):
        rel = path.relative_to(APP_DIR).as_posix()
        if rel.startswith("resources/app-update.yml"):
            continue
        mode = 0o755 if path.is_dir() or os.access(path, os.X_OK) else 0o644
        entries.append((f"{INSTALL_DIR}/{rel}", path, mode))
    for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        source = ICONS / f"{size}x{size}.png"
        entries.append((f"/usr/share/icons/hicolor/{size}x{size}/apps/commit87.png", source, 0o644))
    entries.append(("/usr/share/applications/commit87.desktop", None, 0o644))
    entries.append(("/usr/bin/commit87", None, 0o755))
    entries.append(("/usr/share/licenses/commit87/LICENSE", ROOT / "LICENSE", 0o644))
    return entries


def normalise_tarinfo(info: tarfile.TarInfo, mode: int | None = None) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = int(os.environ.get("SOURCE_DATE_EPOCH", "1762300000"))
    if mode is not None:
        info.mode = mode
    return info


def add_generated(archive: tarfile.TarFile, name: str, content: bytes, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(content)
    normalise_tarinfo(info, mode)
    archive.addfile(info, io.BytesIO(content))


def add_tree(archive: tarfile.TarFile, entries) -> None:
    for destination, source, mode in entries:
        name = destination.lstrip("/")
        if source is None:
            if destination.endswith(".desktop"):
                add_generated(archive, name, DESKTOP.encode(), mode)
            elif destination == "/usr/bin/commit87":
                add_generated(archive, name, WRAPPER.encode(), mode)
            continue
        if source.is_dir():
            info = tarfile.TarInfo(name.rstrip("/") + "/")
            normalise_tarinfo(info, 0o755)
            archive.addfile(info)
        else:
            archive.add(
                str(source),
                arcname=name,
                recursive=False,
                filter=lambda info: normalise_tarinfo(info, mode),
            )


# --------------------------------------------------------------------------- deb


def build_deb(arch: str) -> pathlib.Path:
    out = DIST / f"Commit87-{VERSION}-{arch}.deb"
    control = DIST / "deb-control"
    shutil.rmtree(control, ignore_errors=True)
    (control / "DEBIAN").mkdir(parents=True)

    md5sums: list[str] = []
    for destination, source, _ in tree_entries():
        if source is None or source.is_dir():
            continue
        if destination.startswith("/usr/bin/commit87"):
            continue
        md5sums.append(f"{hashlib.md5(source.read_bytes()).hexdigest()}  {destination.lstrip('/')}")
    md5sums.sort(key=lambda line: line.split("  ", 1)[1])
    (control / "DEBIAN" / "md5sums").write_text("\n".join(md5sums) + "\n")

    control_text = (
        f"Package: {PKG_NAME}\n"
        f"Version: {VERSION}\n"
        f"Section: devel\n"
        f"Priority: optional\n"
        f"Architecture: {arch}\n"
        f"Maintainer: {MAINTAINER}\n"
        f"Installed-Size: {installed_size_kb()}\n"
        f"Depends: {DEB_DEPENDS}\n"
        f"Recommends: git-lfs\n"
        f"Homepage: {HOMEPAGE}\n"
        f"Description: {DISPLAY_NAME} - {SUMMARY}\n"
        + "".join(f" {line}\n" for line in wrap_description(DESCRIPTION, 76))
    )
    (control / "DEBIAN" / "control").write_text(control_text)
    (control / "DEBIAN" / "postinst").write_text(
        "#!/bin/sh\nset -e\ncommand -v update-desktop-database >/dev/null 2>&1 && "
        "update-desktop-database -q /usr/share/applications || true\nexit 0\n"
    )
    (control / "DEBIAN" / "postinst").chmod(0o755)

    data_tar = control / "data.tar.xz"
    with tarfile.open(data_tar, "w:xz", preset=6) as archive:
        add_tree(archive, tree_entries())
    control_tar = control / "control.tar.xz"
    with tarfile.open(control_tar, "w:xz", preset=6) as archive:
        archive.add(str(control / "DEBIAN"), arcname="./", recursive=True, filter=normalise_tarinfo)

    debian_binary = control / "debian-binary"
    debian_binary.write_text("2.0\n")

    parts = [debian_binary, control_tar, data_tar]
    with out.open("wb") as handle:
        handle.write(b"!<arch>\n")
        for part in parts:
            data = part.read_bytes()
            name = f"{part.name}/".ljust(16)
            timestamp = str(int(os.environ.get("SOURCE_DATE_EPOCH", "1762300000"))).ljust(12)
            header = (
                f"{name}{timestamp}0     0     100644  {str(len(data)).ljust(10)}`\n"
            ).encode("ascii")
            handle.write(header)
            handle.write(data)
            if len(data) % 2 == 1:
                handle.write(b"\n")
    for part in parts:
        part.unlink()
    shutil.rmtree(control, ignore_errors=True)
    return out


# --------------------------------------------------------------------------- rpm


def build_rpm(arch: str) -> pathlib.Path:
    top = DIST / "rpmbuild"
    for sub in ("BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS"):
        (top / sub).mkdir(parents=True, exist_ok=True)

    payload = top / "payload"
    shutil.rmtree(payload, ignore_errors=True)
    payload.mkdir()

    for destination, source, mode in tree_entries():
        target = payload / destination.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        if source is None:
            if destination.endswith(".desktop"):
                target.write_text(DESKTOP)
                target.chmod(0o644)
            elif destination == "/usr/bin/commit87":
                target.write_text(WRAPPER)
                target.chmod(0o755)
        elif source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            shutil.copy2(source, target)
            target.chmod(mode)

    file_list: list[str] = []
    for path in sorted(payload.rglob("*")):
        if path.is_file():
            file_list.append("/" + path.relative_to(payload).as_posix())
    files = file_list
    dirs: set[str] = set()
    for entry in files:
        parent = os.path.dirname(entry)
        while parent and parent != "/":
            dirs.add(parent)
            parent = os.path.dirname(parent)

    spec = f"""Name:           {PKG_NAME}
Version:        {VERSION}
Release:        1%{{?dist}}
Summary:        {SUMMARY}
License:        {LICENSE}
URL:            {HOMEPAGE}
Vendor:         Commit87
Packager:       {MAINTAINER}
BuildArch:      {arch}
AutoReqProv:    no

{chr(10).join(f"Requires:       {req}" for req in RPM_REQUIRES)}

%description
{DESCRIPTION}

%install
rm -rf %{{buildroot}}
mkdir -p %{{buildroot}}
cp -a {payload}/. %{{buildroot}}/

%files
{chr(10).join("%dir " + directory for directory in sorted(dirs))}
{chr(10).join(files)}

%changelog
* Wed Nov 04 2026 {MAINTAINER} - {VERSION}-1
- Initial release
"""
    spec_path = top / "SPECS" / f"{PKG_NAME}.spec"
    spec_path.write_text(spec)

    subprocess.run(
        [
            "rpmbuild",
            "-bb",
            "--define", f"_topdir {top}",
            "--define", "_binary_payload w9.xzdio",
            "--define", "_build_id_links none",
            str(spec_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    built = list((top / "RPMS").rglob("*.rpm"))
    if not built:
        raise SystemExit("rpmbuild produced no package")
    out = DIST / f"Commit87-{VERSION}-{arch}.rpm"
    shutil.copy2(built[0], out)
    shutil.rmtree(top, ignore_errors=True)
    return out


# --------------------------------------------------------------------------- pacman


def build_pacman(arch: str) -> pathlib.Path:
    pkgdir = DIST / "pacman-build" / PKG_NAME
    shutil.rmtree(pkgdir.parent, ignore_errors=True)
    (pkgdir / ".PKGINFO").parent.mkdir(parents=True, exist_ok=True)

    pkginfo = [
        f"pkgname = {PKG_NAME}",
        f"pkgbase = {PKG_NAME}",
        f"pkgver = {VERSION}-1",
        f"pkgdesc = {SUMMARY}",
        f"url = {HOMEPAGE}",
        f"builddate = {int(os.environ.get('SOURCE_DATE_EPOCH', '1762300000'))}",
        f"packager = {MAINTAINER}",
        f"size = {installed_size_kb() * 1024}",
        f"arch = {arch}",
        f"license = {LICENSE}",
    ]
    for dep in PACMAN_DEPENDS:
        pkginfo.append(f"depend = {dep}")
    (pkgdir / ".PKGINFO").write_text("\n".join(pkginfo) + "\n")

    install = pkgdir / ".INSTALL"
    install.write_text(
        "post_install() {\n  update-desktop-database -q /usr/share/applications 2>/dev/null || true\n}\n"
        "post_upgrade() { post_install\n}\n"
        "post_remove() {\n  update-desktop-database -q /usr/share/applications 2>/dev/null || true\n}\n"
    )

    for destination, source, mode in tree_entries():
        target = pkgdir / destination.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        if source is None:
            if destination.endswith(".desktop"):
                target.write_text(DESKTOP)
                target.chmod(0o644)
            elif destination == "/usr/bin/commit87":
                target.write_text(WRAPPER)
                target.chmod(0o755)
        elif source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            shutil.copy2(source, target)
            target.chmod(mode)

    out = DIST / f"Commit87-{VERSION}-{arch}.pkg.tar.zst"
    subprocess.run(
        [
            "bsdtar" if shutil.which("bsdtar") else "tar",
            "--zstd",
            "-cf",
            str(out),
            "-C",
            str(pkgdir.parent),
            PKG_NAME,
        ],
        check=True,
    )
    shutil.rmtree(pkgdir.parent, ignore_errors=True)
    return out


def main() -> int:
    if not APP_DIR.is_dir():
        print("dist/linux-unpacked is missing; run `npm run pack:dir` first", file=sys.stderr)
        return 1
    machine = os.uname().machine
    if machine not in ARCH_MAP:
        print(f"unsupported architecture: {machine}", file=sys.stderr)
        return 1
    archs = ARCH_MAP[machine]

    requested = sys.argv[1:] or ["deb", "rpm", "pacman"]
    built: list[pathlib.Path] = []
    for target in requested:
        if target == "deb":
            built.append(build_deb(archs["deb"]))
        elif target == "rpm":
            built.append(build_rpm(archs["rpm"]))
        elif target == "pacman":
            built.append(build_pacman(archs["pacman"]))
        else:
            print(f"unknown target: {target}", file=sys.stderr)
            return 1
    for path in built:
        print(f"{path.name}  {path.stat().st_size / 1024 / 1024:.1f} MiB  sha256={sha256(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())