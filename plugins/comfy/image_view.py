#!/usr/bin/env python3
"""image_view：把一张本地图片变成「带原图像素坐标网格」的图，交给模型看。

为什么要有这么一层：
  模型看图时只能读图上画出来的数字。如果先把图缩放了再让模型报坐标，
  它报的是缩放后的位置，和原图对不上——之前补错位置就是这么来的。
  所以网格、刻度、裁剪全部在这里一次换算好，坐标一律标成原图像素，
  不留给调用方去猜。

用法（只在命令行跑，不联网、不改原图）：
  python image_view.py --path a.png [--crop x,y,w,h] [--scale 4]
                       [--max-width 1024] [--grid 50] [--out out.png]

标准输出最后一行是 JSON；出错时返回 {"ok": false, "error": "..."}。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"缺少 Pillow：{exc}"}, ensure_ascii=False))
    sys.exit(0)

MAX_OUT_BYTES = 3_500_000          # 宿主单张上限 4 MiB，留点余量
BAND_TOP = 20
BAND_LEFT = 44
BAND_RIGHT = 6
BAND_BOTTOM = 6


def fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


def parse_crop(raw: str, w: int, h: int) -> tuple[int, int, int, int, bool]:
    """解析 x,y,w,h 并夹到图内。返回 (x, y, w, h, 是否被夹过)。"""
    try:
        x, y, cw, ch = [int(float(v)) for v in raw.replace("，", ",").split(",")]
    except Exception:
        fail(f"crop 要写成 x,y,w,h 四个整数，收到：{raw!r}")
    clamped = False
    if x < 0:
        cw += x
        x = 0
        clamped = True
    if y < 0:
        ch += y
        y = 0
        clamped = True
    if x >= w or y >= h:
        fail(f"crop 起点在图像外：x={x} y={y}，原图 {w}x{h}")
    if x + cw > w:
        cw = w - x
        clamped = True
    if y + ch > h:
        ch = h - y
        clamped = True
    if cw < 1 or ch < 1:
        fail(f"crop 尺寸不合法：{cw}x{ch}")
    return x, y, cw, ch, clamped


def pick_grid(span: int, want: int) -> int:
    """自动挑一个网格间距，让一个方向上大约出现 4–10 条线。"""
    if want > 0:
        return want
    for step in (10, 20, 25, 50, 100, 200, 250, 500, 1000):
        if 3 <= span / step <= 10:
            return step
    return max(1, span // 6)


def load_font(size: int):
    for path in (
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def flatten(img: Image.Image) -> Image.Image:
    """统一成 RGB；带透明的先铺一层白底，避免透明区变成黑块。"""
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        return bg
    return img.convert("RGB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--crop", default="")
    ap.add_argument("--scale", type=float, default=0.0)
    ap.add_argument("--max-width", dest="max_width", type=int, default=1024)
    ap.add_argument("--grid", type=int, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--out-dir", dest="out_dir", default="")
    args = ap.parse_args()

    path = os.path.abspath(os.path.expanduser(args.path.strip().strip('"').strip("'")))
    if not os.path.isfile(path):
        fail(f"文件不存在：{path}")

    try:
        img = Image.open(path)
        img.load()
    except Exception as exc:
        fail(f"打不开这张图：{exc}")
    src_w, src_h = img.size
    img = flatten(img)

    # 1) 裁剪
    if args.crop.strip():
        cx, cy, cw, ch, clamped = parse_crop(args.crop, src_w, src_h)
    else:
        cx, cy, cw, ch, clamped = 0, 0, src_w, src_h, False
    view = img.crop((cx, cy, cx + cw, cy + ch))

    # 2) 缩放：显式倍数优先；否则按 max_width 缩到合适大小（不放大）
    max_w = max(256, min(2048, args.max_width))
    if args.scale and args.scale > 0:
        scale = max(0.1, min(12.0, args.scale))
    else:
        scale = min(1.0, max_w / float(cw))
    out_w = max(1, int(round(cw * scale)))
    out_h = max(1, int(round(ch * scale)))
    resample = Image.NEAREST if scale >= 2 else Image.LANCZOS
    if (out_w, out_h) != (cw, ch):
        view = view.resize((out_w, out_h), resample)

    # 3) 留边 + 画网格。刻度一律换算回原图坐标。
    canvas = Image.new("RGB", (out_w + BAND_LEFT + BAND_RIGHT, out_h + BAND_TOP + BAND_BOTTOM), (24, 26, 30))
    canvas.paste(view, (BAND_LEFT, BAND_TOP))

    step = pick_grid(max(cw, ch), args.grid)
    font = load_font(13)
    draw = ImageDraw.Draw(canvas)
    x_ticks: list[int] = []
    y_ticks: list[int] = []

    if step > 0:
        # 竖线：原图 x 是 step 的整数倍
        gx = (cx // step) * step
        while gx <= cx + cw:
            if gx >= cx:
                px = BAND_LEFT + int(round((gx - cx) * scale))
                if 0 <= px < out_w + BAND_LEFT:
                    draw.line([(px, BAND_TOP), (px, BAND_TOP + out_h)], fill=(255, 0, 200), width=1)
                    if px >= BAND_LEFT:
                        draw.text((px + 2, 3), str(gx), font=font, fill=(255, 120, 220))
                        x_ticks.append(gx)
            gx += step
        gy = (cy // step) * step
        while gy <= cy + ch:
            if gy >= cy:
                py = BAND_TOP + int(round((gy - cy) * scale))
                if 0 <= py < out_h + BAND_TOP:
                    draw.line([(BAND_LEFT, py), (BAND_LEFT + out_w, py)], fill=(0, 190, 255), width=1)
                    if py >= BAND_TOP:
                        draw.text((2, py - 7), str(gy), font=font, fill=(120, 220, 255))
                        y_ticks.append(gy)
            gy += step

    # 4) 落盘；太大就压成调色板，别超过宿主 4 MiB
    out_path = args.out.strip()
    if not out_path:
        base = args.out_dir.strip() or os.path.dirname(path)
        stamp = datetime.now().strftime("%H%M%S")
        out_path = os.path.join(base, f"_view_{stamp}.png")
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    def save(im: Image.Image) -> int:
        im.save(out_path, "PNG", optimize=True)
        return os.path.getsize(out_path)

    size = save(canvas)
    compressed = False
    if size > MAX_OUT_BYTES:
        canvas.convert("P", palette=Image.ADAPTIVE, colors=256).save(out_path, "PNG", optimize=True)
        size = os.path.getsize(out_path)
        compressed = True
        if size > 4 * 1024 * 1024:
            fail(f"图太大，压到 256 色还有 {size/1024/1024:.1f} MB；缩个范围再看")

    print(json.dumps({
        "ok": True,
        "path": out_path,
        "src": {"w": src_w, "h": src_h},
        "crop": {"x": cx, "y": cy, "w": cw, "h": ch, "clamped": clamped},
        "scale": round(scale, 3),
        "out": {"w": canvas.width, "h": canvas.height, "bytes": size},
        "grid": {"step": step if step > 0 else 0, "x": x_ticks, "y": y_ticks},
        "compressed": compressed,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
