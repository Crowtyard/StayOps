# -*- coding: utf-8 -*-
"""生成 StayOps Desktop 图标（纯 Python 标准库，无 Pillow 依赖）。

输出：
    desktop/build/icon.ico    (electron-builder win.icon，256px 多尺寸 ICO)
    desktop/assets/tray.png   (32px 托盘图标)

实现：纯手工光栅化（品牌色圆角方块 + 白色「屋顶/房」几何标记），
PNG 编码用 zlib + struct，ICO 容器内嵌 PNG（Windows Vista+ 原生支持）。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
ASSETS_DIR = ROOT / "assets"

# StayOps 品牌色（与前端 AppShell 一致的深青绿系）
BRAND = (13, 94, 93, 255)        # #0D5E5D
BRAND_LIGHT = (23, 128, 126, 255)  # 渐变浅端
INK = (31, 41, 55, 255)          # slate-800
CANVAS = (247, 248, 250, 255)    # 近白底
WHITE = (255, 255, 255, 255)

SIZE = 256
ROUND = 56        # 圆角半径
INSET = 18        # 方块外边距
GRID = 6          # 抗锯齿采样网格


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(x, y):
    """返回 (x, y) 处颜色；实现「圆角方块 + 白色屋顶 + 门」的几何标志。"""
    # 抗锯齿：对子像素采样求平均
    r_acc = g_acc = b_acc = a_acc = 0.0
    n = 0
    for sy in range(GRID):
        for sx in range(GRID):
            px = x + (sx + 0.5) / GRID
            py = y + (sy + 0.5) / GRID
            col = sample(px, py)
            r_acc += col[0]
            g_acc += col[1]
            b_acc += col[2]
            a_acc += col[3]
            n += 1
    return (
        int(r_acc / n),
        int(g_acc / n),
        int(b_acc / n),
        int(a_acc / n),
    )


def sample(x, y):
    # 背景：近白
    if not in_rounded_rect(x, y, INSET, INSET, SIZE - INSET, SIZE - INSET, ROUND):
        return CANVAS
    # 品牌渐变（自上而下浅→深）
    t = (y - INSET) / (SIZE - 2 * INSET)
    base = lerp(BRAND_LIGHT, BRAND, min(max(t, 0.0), 1.0))

    # 白色屋顶（三角形 + 屋檐条）与门（白色小方块）
    roof_top = SIZE * 0.30
    roof_base = SIZE * 0.58
    left = SIZE * 0.28
    right = SIZE * 0.72
    # 三角形：顶点 (SIZE/2, roof_top)，底边 [left, right] × roof_base
    if roof_top <= y <= roof_base:
        half = (y - roof_top) / (roof_base - roof_top) * (right - left) / 2
        if abs(x - SIZE / 2) <= half:
            return WHITE
    # 门：底部中央
    door_w = SIZE * 0.12
    door_top = SIZE * 0.58
    if door_top <= y <= SIZE - INSET - 2 and abs(x - SIZE / 2) <= door_w / 2:
        return WHITE
    return base


def encode_png(width, height, rows):
    """rows: list[bytes]，每行 RGBA；返回 PNG bytes。"""
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def render_png(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            row.extend(pixel(x * SIZE / size, y * SIZE / size))
        rows.append(bytes(row))
    return encode_png(size, size, rows)


def write_ico(png_bytes, sizes=(16, 32, 48, 64, 128, 256)):
    images = {s: render_png(s) for s in sizes}
    # ICO 目录项（内嵌 PNG：宽度/高度 0 表示 256）
    header = struct.pack("<HHH", 0, 1, len(sizes))
    entries = b""
    offset = 6 + 16 * len(sizes)
    for s in sizes:
        data = images[s]
        entries += struct.pack(
            "<BBBBHHII",
            0 if s == 256 else s,
            0 if s == 256 else s,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        offset += len(data)
    return header + entries + b"".join(images[s] for s in sizes)


def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    ico = write_ico(render_png(256))
    (BUILD_DIR / "icon.ico").write_bytes(ico)
    (ASSETS_DIR / "tray.png").write_bytes(render_png(32))
    print(f"icon.ico: {(BUILD_DIR / 'icon.ico').stat().st_size} bytes")
    print(f"tray.png: {(ASSETS_DIR / 'tray.png').stat().st_size} bytes")


if __name__ == "__main__":
    main()
