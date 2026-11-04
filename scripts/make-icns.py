#!/usr/bin/env python3
"""Builds build/icon.icns from the generated PNGs without needing macOS tools.

ICNS is a container of typed chunks. Modern macOS accepts PNG payloads for the
ic07..ic14 types, which is all electron-builder needs.
"""
from __future__ import annotations

import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "build" / "icons"
OUT = ROOT / "build" / "icon.icns"

# type -> png size
CHUNKS = [
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
    ("ic11", 32),
    ("ic12", 64),
    ("ic13", 256),
    ("ic14", 512),
]


def main() -> int:
    payload = bytearray()
    for kind, size in CHUNKS:
        source = ICONS / f"{size}x{size}.png"
        if not source.exists():
            print(f"missing {source}; run scripts/make-icons.sh first", file=sys.stderr)
            return 1
        data = source.read_bytes()
        payload += kind.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    icns = b"icns" + struct.pack(">I", len(payload) + 8) + bytes(payload)
    OUT.write_bytes(icns)
    print(f"wrote {OUT} ({len(icns)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())