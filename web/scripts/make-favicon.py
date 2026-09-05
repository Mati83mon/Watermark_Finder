#!/usr/bin/env python3
"""Rasterise the Watermark Finder mark into a PNG-in-ICO, standard library only.

Browsers request /favicon.ico regardless of what the document declares, so the
site needs the file even though `app/icon.svg` supplies the modern link tag.
Drawing it here - rather than committing a binary from an image editor - keeps
the icon reproducible: the geometry below is the same circle and handle as
web/app/icon.svg, and the file can be regenerated from source at any time.
"""

import binascii
import math
import pathlib
import struct
import zlib

SIZE = 32
SS = 4  # supersampling factor, for antialiased edges
ACCENT = (0x43, 0x38, 0xCA)
WHITE = (0xFF, 0xFF, 0xFF)


def rounded_rect(x, y, w, h, r):
    """Signed distance to a rounded rectangle, negative inside."""
    cx, cy = w / 2, h / 2
    dx, dy = abs(x - cx) - (cx - r), abs(y - cy) - (cy - r)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return outside + min(max(dx, dy), 0.0) - r


def ring(x, y, cx, cy, radius, width):
    """Signed distance to a circular stroke of the given width."""
    return abs(math.hypot(x - cx, y - cy) - radius) - width / 2


def segment(x, y, ax, ay, bx, by, width):
    """Signed distance to a round-capped line segment."""
    vx, vy = bx - ax, by - ay
    wx, wy = x - ax, y - ay
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    return math.hypot(wx - t * vx, wy - t * vy) - width / 2


def coverage(distance):
    """Convert a signed distance to alpha, one pixel of feathering."""
    return max(0.0, min(1.0, 0.5 - distance))


def pixels():
    rows = []
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS

                    bg = coverage(rounded_rect(x, y, SIZE, SIZE, 7))
                    lens = coverage(ring(x, y, 13.5, 13.5, 7.2, 2.6))
                    handle = coverage(segment(x, y, 18.9, 18.9, 25.4, 25.4, 3.2))
                    mark = max(lens, handle)

                    # White mark composited over the accent plate.
                    sr = ACCENT[0] * (1 - mark) + WHITE[0] * mark
                    sg = ACCENT[1] * (1 - mark) + WHITE[1] * mark
                    sb = ACCENT[2] * (1 - mark) + WHITE[2] * mark

                    r += sr * bg
                    g += sg * bg
                    b += sb * bg
                    a += bg
            n = SS * SS
            alpha = a / n
            if alpha > 0:
                # Un-premultiply so the edge keeps its colour as it fades out.
                row += bytes(
                    (
                        round(r / a),
                        round(g / a),
                        round(b / a),
                        round(alpha * 255),
                    )
                )
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def png(rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body))

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico(png_bytes):
    # ICONDIR, then one ICONDIRENTRY pointing at an embedded PNG.
    directory = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack(
        "<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(png_bytes), 6 + 16
    )
    return directory + entry + png_bytes


if __name__ == "__main__":
    data = png(pixels())
    out = pathlib.Path(__file__).resolve().parent.parent / "public" / "favicon.ico"
    with out.open("wb") as handle:
        handle.write(ico(data))
    print(f"{out}: {len(ico(data))} bytes ({SIZE}x{SIZE} PNG-in-ICO)")
