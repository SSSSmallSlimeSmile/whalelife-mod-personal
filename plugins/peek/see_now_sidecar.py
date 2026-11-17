"""看屏·按变化取帧 —— WhaleLife 边车版。

从 AstrBot 的 astrbot_plugin_see_now 0.1.0 搬来（思路借自 dsh-see-now，Apache-2.0，
作者 SAOS-3624）。抓屏、判分、留帧、定档、装箱、认字这一整条主线一行没改；
只把「AstrBot 插件」换成「命令行边车」：参数走命令行，结果一行 JSON 到 stdout，
日志全走 stderr，父进程读完就退出。

用法：
    python see_now_sidecar.py [选项]

选项：
    --seconds 10           抓多久（2–60 秒）
    --max-frames 6         一张图最多装几帧（1–12）
    --tier-style native    native / up / down
    --tier-lock 0          锁死一档 1-3，0 = 不锁，压过 tier-style
    --focus auto           auto / whole / content（auto：热点 8-60% 才裁）
    --max-width 1600       成品图最大宽度，超出等比缩
    --shot-dir DIR         截图目录，默认脚本旁边的 shots
    --text-layer           UIA + OCR 认一次字（默认关，一次几百毫秒）
    --list                 只打印目录和依赖自检

识图不在这里做：出的是图，谁来看由 WhaleLife 那头决定。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageGrab  # noqa: F401


class logger:
    """AstrBot 的 logger 垫片：原文里 logger.info(...) 全是 %-格式，照原样能用。"""

    @staticmethod
    def _emit(level: str, msg, *a) -> None:
        try:
            text = (msg % a) if a else str(msg)
        except Exception:
            text = str(msg)
        print("[see_now] %s %s" % (level, text), file=sys.stderr, flush=True)

    @classmethod
    def info(cls, msg, *a):
        cls._emit("I", msg, *a)

    @classmethod
    def warning(cls, msg, *a):
        cls._emit("W", msg, *a)

    @classmethod
    def error(cls, msg, *a):
        cls._emit("E", msg, *a)


# AstrBot 的这几个名字只出现在搬过来但用不上的残留函数签名里，给个占位免得 NameError。
AstrMessageEvent = object
filter = object
Context = object
Star = object


def register(*_a, **_k):
    return lambda cls: cls


# ---- 采集 ----
FPS = 6
SHOT = (800, 450)

# ---- 判分（口径照 dsh-see-now 的 README）----
GRID = (64, 36)
CUT_ABS = 12.0          # 绝对地板：低于它一律不算切点
CUT_PEAK = 2.5          # 尖峰：要比邻居大这么多才算「一下子」
REFRACT = 0.4           # 不应期，秒
NEED = 144.0            # 积分阈值 = 4 分 × 12fps × 3 秒

# ---- 裁切：模型那头的图会被压到同一个 token 栅格，全屏送过去等于自废细节 ----
#: 成品包的上限。控件四十件、合起来八十块——再多，模型读它跟读整屏没区别。
_BLOCK_CTRL_CAP = 40
_BLOCK_CAP = 80

DIFF_GRID = (320, 180)  # 算包围盒用的分辨率
DIFF_LEVEL = 10.0       # 灰度差多少算「变了」
CROP_PAD = 24           # 包围盒往外放宽多少像素（原图尺度）
CROP_MAX = 0.55         # 变化区占全屏超过这个比例就不裁，不如整屏看

# ---- 档位：分数越高，占的格子越大 ----
TIERS = ((45.0, 1), (18.0, 2), (0.0, 3))
TIER_MAX = 3            # 最大档号；k 越小格子越大，1 档独占整行
#: 一张成图的高度上限。锁档时帧数按它截断——六帧全锁 1 档是 2700px 的长条，
#: token 全花在空处。三行封顶，够看也够省。
MAX_PACK_H = SHOT[1] * 3

# ---- 认内容：整屏递过去，一半格子交给界面外壳，真正在看的东西反而只有半幅 ----
#: 热点区低于这个占屏比例，说明变化是零散噪点，没内容区可挑。
FOCUS_MIN = 0.06
#: 高于这个比例，说明满屏都在动（切页、拖窗口），挑出来也没意义，整幅更好。
FOCUS_MAX = 0.85
#: auto 档：热点占屏落在这个区间才裁，太小是噪点、太大是整屏在动。
AUTO_MIN = 0.08
AUTO_MAX = 0.60
#: 前台窗口占屏区间。低于下限是浮窗/提示条，高于上限是全屏——两头都不裁。
FG_MIN = 0.08
FG_MAX = 0.92
#: 热点图累计峰值的门槛。整段都没热起来，就别硬裁一块出来放大空气。
FOCUS_PEAK = 3.0
#: 认内容时换一套留帧口径。整屏平均差一两分其实就是视频在放，原来那套（12 分起）
#: 会把整段画面当静止，一帧不留——裁得再准也没有帧可裁。
FOCUS_CUT_ABS = 2.5
FOCUS_SPIKE = 2.0
FOCUS_NEED = 24.0


def _shot() -> tuple[Image.Image, np.ndarray]:
    """一次抓屏，出两份：原图留着备取，小图拿去判分。

    原先每帧都缩到 800×450 再缩到 64×36，中间那张大图九成时候没人要。
    抓一次花 46 毫秒，白缩一次 18 毫秒——省下的不是钱，是采样率。
    """
    img = ImageGrab.grab()
    small = np.asarray(img.convert("RGB").resize(GRID, Image.BILINEAR), dtype=np.float32)
    return img, small


def _big(img: Image.Image) -> np.ndarray:
    """只有决定留帧了，才把它缩到装图用的尺寸。"""
    return np.asarray(img.convert("RGB").resize(SHOT, Image.BILINEAR), dtype=np.float32)


def _score(prev: np.ndarray, cur: np.ndarray) -> float:
    """0-255 的变化分：HSV 三通道加权差，H 走环形。"""
    a = np.asarray(Image.fromarray(prev.astype(np.uint8)).convert("HSV"), dtype=np.float32)
    b = np.asarray(Image.fromarray(cur.astype(np.uint8)).convert("HSV"), dtype=np.float32)
    dh = np.abs(a[..., 0] - b[..., 0])
    dh = np.minimum(dh, 255.0 - dh)
    ds = np.abs(a[..., 1] - b[..., 1])
    dv = np.abs(a[..., 2] - b[..., 2])
    return float((0.20 * dh + 0.25 * ds + 0.55 * dv).mean())


def _tier(s: float) -> int:
    for floor, k in TIERS:
        if s >= floor:
            return k
    return 3

def _pick_tier(s: float, style: str = "native", lock: int = 0) -> int:
    """分数 → 档号。lock 压过 style；style 只把算出来的结果整体挪一档。

    k 越小格子越大：1 档独占整行（800×450），3 档三分之一宽。原版把这两件事
    拧在一起——节奏一变，格子跟着变，用户看不出是哪儿改的，也改不动。这里拆开。
    """
    if lock:
        return max(1, min(TIER_MAX, int(lock)))
    k = _tier(s)
    if style == "up":
        k = max(1, k - 1)
    elif style == "down":
        k = min(TIER_MAX, k + 1)
    return k

def _frame_limit(lock: int) -> int:
    """锁档后一张图还塞得下几帧；不锁就返回 12（工具参数的上限）。

    1 档一行只放得下一个，三行封顶就是 3 帧。2、3 档一行分别放 2、3 个，
    高度上限吃得住，不额外卡。
    """
    if not lock:
        return 12
    k = max(1, min(TIER_MAX, int(lock)))
    cell_w, cell_h = SHOT[0] // 3, SHOT[1] // 3
    tile_w, tile_h = cell_w * 3 // k, cell_h * 3 // k
    per_row = max(1, SHOT[0] // tile_w)
    rows = MAX_PACK_H // tile_h
    return max(1, min(12, per_row * rows))

def _tier_note(plan: dict | None, style: str, lock: int) -> str:
    """给人看的一行档位说明："锁 2 档（2档×4，共 4 帧）"。

    以前只能看出「格子变了」，说不清是节奏、偏移还是锁档干的。
    """
    tiers = (plan or {}).get("tiers") or {}
    if not tiers:
        return ""
    if lock:
        head = "锁 %d 档" % lock
    elif style == "up":
        head = "整体大一档"
    elif style == "down":
        head = "整体小一档"
    else:
        head = "按变化分档"
    body = "，".join("%d档×%d" % (k, n) for k, n in sorted(tiers.items()))
    tail = "，共 %d 帧" % sum(tiers.values())
    dropped = (plan or {}).get("dropped") or 0
    if dropped:
        tail += "；另 %d 帧超高度上限没装" % dropped
    return "%s（%s%s）" % (head, body, tail)


def _changed_box(prev: Image.Image, cur: Image.Image):
    """两张原图之间，到底哪一块变了。返回原图坐标系里的 (l, t, r, b)，没变就返回 None。

    这一步是本地算的：阈值、比较、包围盒，都不花一个 token。模型只负责解释
    「这块变成什么了」，不用它判断「有没有变」——它在这方面爱编。
    """
    if prev is None:
        return None
    a = np.asarray(prev.convert("L").resize(DIFF_GRID, Image.BILINEAR), dtype=np.float32)
    b = np.asarray(cur.convert("L").resize(DIFF_GRID, Image.BILINEAR), dtype=np.float32)
    mask = np.abs(a - b) > DIFF_LEVEL
    if not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    gw, gh = DIFF_GRID
    W, H = cur.size
    sx, sy = W / float(gw), H / float(gh)
    left = max(0.0, xs.min() * sx - CROP_PAD)
    top = max(0.0, ys.min() * sy - CROP_PAD)
    right = min(float(W), (xs.max() + 1) * sx + CROP_PAD)
    bottom = min(float(H), (ys.max() + 1) * sy + CROP_PAD)
    return (left, top, right, bottom)


def _crop_for_model(img: Image.Image, box):
    """只把变化那一块裁出来。小图会被原样放过，细节才保得住。

    返回 (图, 说明)；变化太大或没有变化时返回 None，让调用方走整屏。
    """
    if box is None:
        return None
    W, H = img.size
    l, t, r, b = box
    area = max(0.0, (r - l)) * max(0.0, (b - t))
    if area <= 0 or area > (W * H) * CROP_MAX:
        return None
    crop = img.crop((int(l), int(t), int(r), int(b)))
    if crop.size[0] < 120 or crop.size[1] < 90:
        return None
    return crop


def _pack(frames: list[tuple[np.ndarray, float]], out: str,
          style: str = "native", lock: int = 0, max_width: int = 0) -> dict:
    """按档位分行摆：格子宽高都是 cell * 3 // k，k 越小占得越大。

    只有一帧时强制铺满——单帧塞进最小格，出来就是一条窄缝，模型只会说「看不到」。
    原版对这种情形用的就是 strategy: 'single'。

    两处跟老版本不一样：
      * 尺寸改成 width * 3 // k 而不是 width * (3 // k)。后者在 k=2、k=3 时都算出
        1 倍宽度，二三档根本长一个样，等于白分三档。
      * lock > 0 时所有帧压到这一档，超过高度预算的从尾巴砍掉：按时间顺序留前面，
        后面的变化没人在等了，宁可少给也别给一张 2700px 的长条。

    返回 {"path", "tiers": {档号: 帧数}, "dropped"}，档位分布要报给调用方。
    """
    single = len(frames) == 1
    cell_w, cell_h = SHOT[0] // 3, SHOT[1] // 3
    gap = 6
    rows: list[list[tuple[np.ndarray, int]]] = []
    cur: list[tuple[np.ndarray, int]] = []
    used = 0
    for img, s in frames:
        k = 1 if single else _pick_tier(s, style, lock)
        w = cell_w * 3 // k
        if used + w > cell_w * 3 and cur:
            rows.append(cur)
            cur, used = [], 0
        cur.append((img, k))
        used += w
    if cur:
        rows.append(cur)

    dropped = 0
    if lock and not single and rows:
        while len(rows) > 1:
            heights = [max(cell_h * 3 // k for _img, k in row) for row in rows]
            # 只比图本身的高度，间隔不计——间隔是包装，不该把整帧挤出去。
            if sum(heights) <= MAX_PACK_H:
                break
            dropped += len(rows.pop())

    width = cell_w * 3
    heights = [max(cell_h * 3 // k for _img, k in row) for row in rows]
    canvas = Image.new("RGB", (width, sum(heights) + gap * (len(rows) + 1)), (18, 18, 18))
    y = gap
    tiers: dict[int, int] = {}
    for row, h in zip(rows, heights):
        x = gap
        for img, k in row:
            w = cell_w * 3 // k
            tile = Image.fromarray(img.astype(np.uint8)).resize((max(1, w - gap), h), Image.BILINEAR)
            canvas.paste(tile, (x, y))
            x += w
            tiers[k] = tiers.get(k, 0) + 1
        y += h + gap
    if max_width and canvas.width > max_width:
        ratio = max_width / float(canvas.width)
        canvas = canvas.resize((max_width, max(1, int(canvas.height * ratio))), Image.LANCZOS)
    canvas.save(out)
    return {"path": out, "tiers": tiers, "dropped": dropped, "size": canvas.size}



def _foreground_box(screen_size):
    """取当前前台窗口在屏幕上的比例框；拿不到、或占屏超出 FG 区间，返回 None。

    热点图挑的是「哪块动得多」。终端在刷输出、视频同时在放的时候，它可能挑中
    你不看的那块——所以 auto 先问前台窗口：带焦点的那个才是眼睛对着的地方。
    """
    if not sys.platform.startswith("win"):
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None

        # GetWindowRect 为主：实测它给的是真窗口框。
        # DWM 那条（DWMWA_EXTENDED_FRAME_BOUNDS=9）在某些驱动上会吐整屏尺寸，
        # 拿它当首选会把「全屏」误判成「整屏在动」而永远不裁，所以只拿它做一次校验。
        rect = wintypes.RECT()
        if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
            return None
        try:
            dwm = wintypes.RECT()
            if ctypes.windll.dwmapi.DwmGetWindowAttribute(
                    wintypes.HWND(hwnd), 9, ctypes.byref(dwm), ctypes.sizeof(dwm)) == 0:
                dw = dwm.right - dwm.left
                dh = dwm.bottom - dwm.top
                W0, H0 = screen_size
                # 只有 DWM 给的框更小、又不像整屏，才采用（去掉阴影那几像素）
                if 160 <= dw < W0 and 120 <= dh < H0:
                    rect = dwm
        except Exception:
            pass

        W, H = screen_size
        left = max(0, min(W, int(rect.left)))
        top = max(0, min(H, int(rect.top)))
        right = max(0, min(W, int(rect.right)))
        bottom = max(0, min(H, int(rect.bottom)))
        if right - left < 160 or bottom - top < 120:
            return None

        area = ((right - left) * (bottom - top)) / float(W * H)
        if area < FG_MIN or area > FG_MAX:
            return None
        return (left / float(W), top / float(H), right / float(W), bottom / float(H), area)
    except Exception:
        return None



def _inner_box(outer, inner, min_area: float = 0.06):
    """前台窗口与热点区取交集，交集太小就 None。

    实测热点框常跨出窗口——窗口在放视频、它下面的终端同时在刷输出，两个热点连成
    一个更大的外接框，包含式判断永远不成立，只能框住整个窗口连标签栏一起送。
    交集既保住「只看前台」，又贴到真正在动的那块。
    """
    if not outer or not inner:
        return None
    x0 = max(outer[0], inner[0])
    y0 = max(outer[1], inner[1])
    x1 = min(outer[2], inner[2])
    y1 = min(outer[3], inner[3])
    if x1 <= x0 or y1 <= y0:
        return None
    area = (x1 - x0) * (y1 - y0)
    if area < min_area:
        return None
    return (x0, y0, x1, y1, area)

def _focus_box(hot: np.ndarray, lo: float = FOCUS_MIN, hi: float = FOCUS_MAX, peak_min: float = FOCUS_PEAK):
    """从累计热点图里挑出「一直在变的那块」，返回比例框；挑不出就 None。

    整屏差异把两件事混成一个分数：页面跳一下满屏都换，分数爆表；视频真在放，
    只有播放器那一块在动，一平均就剩个位数。所以不再看总分，改看「哪块热」。
    """
    if hot.size == 0:
        return None
    peak = float(hot.max())
    if peak < peak_min:
        return None
    ys, xs = np.where(hot >= max(FOCUS_PEAK, peak * 0.25))
    if ys.size == 0:
        return None
    h, w = hot.shape
    x0, x1 = float(xs.min()) / w, float(xs.max() + 1) / w
    y0, y1 = float(ys.min()) / h, float(ys.max() + 1) / h
    area = (x1 - x0) * (y1 - y0)
    if area < lo or area > hi:
        return None
    return (x0, y0, x1, y1, area)


def _cut_focus(img: Image.Image, box):
    """按比例框从原图裁内容区。裁完太小就当没裁——那点像素放大也没东西。"""
    W, H = img.size
    x0, y0, x1, y1 = box[:4]
    left = max(0, int(x0 * W) - CROP_PAD)
    top = max(0, int(y0 * H) - CROP_PAD)
    right = min(W, int(x1 * W) + CROP_PAD)
    bottom = min(H, int(y1 * H) + CROP_PAD)
    if right - left < 160 or bottom - top < 120:
        return None
    return np.asarray(img.convert("RGB").crop((left, top, right, bottom)), dtype=np.float32)


def _grab_run(seconds: float, max_frames: int, focus: str = "whole"):
    """抓一段，按判据留帧。返回（抓了多少帧，留下了哪些，最后那帧的原图）。

    一帧都没留下时，列表是空的，由调用方决定要不要复用上一张。
    原图另给一份——文字层要拿它去 OCR，缩过的小图糊得认不出字。

    focus=True 时多一步：拿整段的累计热点找内容区，每帧按同一块裁出来再装包，
    标签栏、地址栏、侧边推荐都不进图。第五项是这步的说明，没做就是 None。
    """
    frames: list[tuple[np.ndarray, float]] = []
    kept_raw: list[Image.Image] = []
    hot = np.zeros((GRID[1], GRID[0]), dtype=np.float32)
    first, prev_small = _shot()
    last_raw = first
    prev_raw = first
    diff_pair = None
    prev_score = 1.0
    integ = 0.0
    last_cut = 0.0
    t0 = time.time()
    shots = 0
    next_at = t0

    # 认内容时不跟整屏突变走，跟「一直在动」走：门槛压到 2.5 分、积分攒够 24
    # 就留一帧，视频那种缓慢流动才留得住。静止画面里顶多被光标和时钟勾一两帧，
    # 有 max_frames 兜着，不至于满盘。
    tracking = focus in ("content", "auto")
    cut_abs = FOCUS_CUT_ABS if tracking else CUT_ABS
    cut_peak = FOCUS_SPIKE if tracking else CUT_PEAK
    need = FOCUS_NEED if tracking else NEED

    while time.time() - t0 < seconds and len(frames) < max_frames:
        # 按节拍走，而不是「睡一觉再干活」——后者会把每帧的耗时也加进周期，
        # 目标 6 帧/秒实际只跑出 4.4 帧/秒。
        next_at += 1.0 / FPS
        time.sleep(max(0.0, next_at - time.time()))
        img, cur_small = _shot()
        last_raw = img
        s = _score(prev_small, cur_small)
        shots += 1
        now = time.time()

        if tracking:
            # 每帧顺手把差异摊到热点图上，抓完才知道「哪块一直在动」。
            hot += np.abs(cur_small - prev_small).mean(axis=2)

        if (s >= cut_abs and s > cut_peak * max(1.0, prev_score)
                and now - last_cut >= REFRACT):
            frames.append((_big(img), s))
            if tracking:
                kept_raw.append(img)
            last_cut = now
            integ = 0.0
            diff_pair = (prev_raw, img)
        else:
            integ += s
            if integ >= need:
                frames.append((_big(img), s))
                if focus:
                    kept_raw.append(img)
                integ = 0.0
                diff_pair = (prev_raw, img)

        prev_small, prev_score = cur_small, s
        prev_raw = img

    note = None
    if focus in ("content", "auto") and frames and len(kept_raw) == len(frames):
        if focus == "auto":
            # 前台窗口优先：它带焦点，代表眼睛真正对着的那块。
            # 但它连标签栏一起框进来，所以里面若有更贴画面的变化区，就取那块。
            size = kept_raw[0].size
            fg = _foreground_box(size)
            hm = _focus_box(hot, AUTO_MIN, AUTO_MAX, FOCUS_PEAK)
            inner = _inner_box(fg, hm) if fg else None
            if inner:
                box, src_of_box = inner, "前台窗口内的变化区"
            elif fg:
                box, src_of_box = fg, "前台窗口"
            else:
                box, src_of_box = hm, "热点区"
        else:
            box, src_of_box = _focus_box(hot), "热点区"
        cut = [(_cut_focus(raw, box) if box else None, s)
               for (_arr, s), raw in zip(frames, kept_raw)]
        if box and all(c[0] is not None for c in cut):
            frames = [(c[0], c[1]) for c in cut]
            note = "只送内容区（%s 占屏 %d%%），外壳裁掉" % (src_of_box, round(box[4] * 100))
        elif focus == "content":
            note = "没挑出单一内容区，照原样整幅"
        else:
            note = ("前台窗口没拿到或占屏超出 8%-92%，"
                    "热点区也不在 8%-60% 之间（太小是噪点、太大是整屏在动），照整屏送")

    return shots, frames, last_raw, diff_pair, note


def _despace(text: str) -> str:
    """中文被 OCR 一格一格拆开了，这里把字缝捏回去，别的一律不动。"""
    import re as _re
    prev = None
    while prev != text:
        prev = text
        text = _re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)
    return text


def _near(a: str, b: str) -> bool:
    """两条名字像不像同一个东西。给成品包去重用——OCR 那头的错字不该占两行。

    控件名常常是几段字连起来报的（"聊天 输入框 发送"），OCR 报的是其中一段。
    所以不能只比整串：拿 OCR 那段的长短，在控件名上滑一遍，取最像的一窗。
    """
    a, b = (a or "").strip().lower(), (b or "").strip().lower()
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return True
    if len(a) > len(b):
        a, b = b, a
    if len(a) < 4:
        return False
    import difflib

    best = 0.0
    win = len(a)
    for i in range(0, len(b) - win + 1):
        r = difflib.SequenceMatcher(None, a, b[i:i + win]).ratio()
        if r > best:
            best = r
            if best >= 0.86:
                return True
    return best >= 0.86


def _text_layer(png: str, timeout: float = 8.0) -> dict:
    """把屏幕编译成文字与坐标，摆在模型面前当文本读。

    两条腿都借自 Windows 自己：UI Automation 报控件树，Media.Ocr 抠字。
    比起把图递过去让它猜，这一步只是把「猜」换成「问」。
    """
    import subprocess

    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pack_screen.ps1")
    if not os.path.exists(script):
        return {"ok": False, "error": "pack_screen.ps1 不在"}
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", script, "-Path", png, "-MaxElements", "40", "-MaxLines", "80"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

    raw = (proc.stdout or "").strip()
    if not raw:
        return {"ok": False, "error": "powershell 没回话"}
    try:
        data = json.loads(raw.splitlines()[-1])
    except Exception:
        return {"ok": False, "error": "回话不是 JSON"}
    if not data.get("ok"):
        return {"ok": False, "error": data.get("ocr_error") or "打包失败"}

    elements = []
    for item in data.get("elements") or []:
        name = str(item.get("n") or "").strip()
        if not name:
            continue
        elements.append("%s[%s] %s" % (name, item.get("t", ""),
                                       "%d,%d" % (item.get("x", 0), item.get("y", 0))))

    lines, seen = [], set()
    ocr_rows = []
    for item in data.get("lines") or []:
        raw_text = str(item.get("t") or "")
        text = _despace(raw_text).strip()
        if len(text) < 2 or text in seen:
            continue
        seen.add(text)
        lines.append(text)
        ocr_rows.append({
            "k": "字",
            "t": text,
            "x": int(item.get("x") or 0),
            "y": int(item.get("y") or 0),
        })

    text = "\n".join(lines)
    if len(text) > 1400:
        text = text[:1400] + "…（后面截了）"

    # 成品包：控件和字本来分两条腿，模型拿到手还得自己按坐标拼成「屏幕上是什么」。
    # 这里先拼好——同一处、同一个名字的只留一份（控件名通常比 OCR 认出来的干净），
    # 再按从上到下、从左到右排一遍，模型照顺序读就是眼睛的顺序。
    blocks = []
    ctrl_names = set()
    for item in data.get("elements") or []:
        if len(blocks) >= _BLOCK_CTRL_CAP:
            break
        name = str(item.get("n") or "").strip()
        if not name:
            continue
        ctrl_names.add(_despace(name).strip())
        blocks.append({
            "k": "控件",
            "t": name,
            "r": str(item.get("t") or ""),
            "x": int(item.get("x") or 0),
            "y": int(item.get("y") or 0),
        })
    for row in ocr_rows:
        if len(blocks) >= _BLOCK_CAP:
            break
        if row["t"] in ctrl_names:
            continue
        # OCR 认字常把 I 认成 l、把 U 认成 Ul；控件名是程序自己报的，准得多。
        # 两成半的字不一样就当成同一处，别再让同一样东西在包里出现两回。
        if any(_near(row["t"], name) for name in ctrl_names):
            continue
        blocks.append(row)
    blocks.sort(key=lambda b: (b["y"] // 28, b["x"]))

    return {
        "ok": True,
        "window": str(data.get("window") or "").strip(),
        "elements": elements[:40],
        "blocks": blocks[:_BLOCK_CAP],
        "block_count": len(blocks[:_BLOCK_CAP]),
        "text": text,
        "chars": len(text),
        "ms": int(data.get("elapsed_ms") or 0),
    }


#: 云端识图的默认问法。要点是逼它说「谁、在哪、干了什么」，而不是复述 UI。
DEFAULT_CLOUD_PROMPT = (
    "这是屏幕截图，可能一张，也可能两张（按时间顺序）。说清四件事：屏幕主体是什么；"
    "画面里有没有人物或角色，有几个，各自在哪个位置、在做什么；如果给了两张，第二张相对"
    "第一张哪里变了、变成了什么。只说看得见的，三句以内。")

_CLOUD_CRED: tuple | None = None


def _cloud_cred():
    """借 AstrBot 主配置里的 deepseek key。

    不另存一份——key 存两处就得同步两处，早晚错一次。
    """
    global _CLOUD_CRED
    if _CLOUD_CRED is not None:
        return _CLOUD_CRED or None
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "cmd_config.json"))
    try:
        with open(path, encoding="utf-8-sig") as fh:
            conf = json.load(fh)
    except Exception as exc:
        logger.warning("[see_now] 读不到 cmd_config.json：%s", exc)
        _CLOUD_CRED = ()
        return None
    for src in conf.get("provider_sources") or []:
        if src.get("id") == "deepseek" and src.get("key"):
            base = str(src.get("api_base") or "https://api.deepseek.com/v1").rstrip("/")
            _CLOUD_CRED = (base, str(src["key"][0]))
            return _CLOUD_CRED
    _CLOUD_CRED = ()
    return None


def _cloud_look(frames: list, prompt: str, model: str, max_tokens: int,
                pair: bool, think: bool = False) -> tuple[str, str]:
    """把留住的那几帧直接发给 deepseek 看图。

    跟本地 qwen3-vl 是一件事、两种代价：本地不花钱但认不准，云端认得出角色和动作
    但每帧要多等两三秒。哪头划算，交给配置说。
    """
    cred = _cloud_cred()
    if not cred:
        return "", "云端识图没借到 key（cmd_config 里没找到 deepseek 的 provider_sources）。"
    import base64
    import io
    import urllib.request

    if not frames:
        return "", "没有帧可送。"
    picks = [frames[0], frames[-1]] if (pair and len(frames) > 1) else [frames[-1]]
    imgs = []
    for arr, _s in picks:
        im = Image.fromarray(np.ascontiguousarray(arr.astype(np.uint8)))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=72)
        imgs.append(base64.b64encode(buf.getvalue()).decode())

    content = [{"type": "text", "text": prompt}]
    for b in imgs:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + b}})
    body = {"model": model, "max_tokens": int(max_tokens),
            "messages": [{"role": "user", "content": content}]}
    if not think:
        # 这个模型默认先写一大段推理再吐正文。看屏幕这活儿不需要它推演，
        # 关掉之后同一张图 3.3 秒变 1.3 秒，输出从三百多 token 掉到三十几。
        body["thinking"] = {"type": "disabled"}
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        cred[0] + "/chat/completions", data=payload,
        headers={"Authorization": "Bearer " + cred[1], "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode())
    except Exception as exc:
        raw = getattr(exc, "read", lambda: b"")()
        logger.warning("[see_now] 云端识图失败：%s %s", type(exc).__name__, exc)
        return "", ("云端识图没成：%s %s"
                    % (type(exc).__name__, raw[:120].decode("utf-8", "replace")))
    txt = (data["choices"][0]["message"].get("content") or "").strip()
    el = time.time() - t0
    if not txt:
        # 这个模型先烧 reasoning 再吐正文，max_tokens 给少了就只剩推理、正文空着。
        return "", ("云端识图只出了推理，正文是空的——多半 max_tokens 给少了（%.1f 秒就断在那儿）。"
                    "把 cloud_tokens 往上调再试。" % el)
    return txt, "look 是 deepseek 看完图说的（%.1fs，%d 张）。要抠细节还是读 path 那张。" % (el, len(imgs))


def _describe(path: str, model: str, url: str) -> str:
    """把拼好的图交给本地视觉模型，换一段人话回来。

    主对话那条线多半不吃图，所以这一步不是可选项——没有它，图就只是盘上一个文件。
    """
    import base64
    import json as _json
    import urllib.request

    try:
        with open(path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        body = _json.dumps({
            "model": model,
            "prompt": ("这张图是按时间顺序拼起来的屏幕截图，格子越大表示那一刻变化越剧烈。"
                       "直接报结论，不要复述推理过程，不要自问自答，不要分点。"
                       "用两到三句话说清三件事：是什么程序、正在做什么、最明显的一处变化是什么。"
                       "看不出来就写「看不出」。/no_think"),
            "images": [b64],
            "stream": False,
            "think": False,
            "options": {"temperature": 0.1, "num_predict": 1400},
        }).encode()
        req = urllib.request.Request(url.rstrip("/") + "/api/generate", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = _json.loads(resp.read())
        # qwen3-vl 会先把 token 花在 thinking 上；正文字空的时候，就从那儿取。
        answer = str(data.get("response") or "").strip()
        if not answer:
            answer = str(data.get("thinking") or "").strip()
        return answer
    except Exception as exc:
        return "（识图失败：%s: %s）" % (type(exc).__name__, exc)



# ---------------- 边车入口：把工具那段搬成命令行 ----------------

def _last_path(shot_dir: str) -> str:
    return os.path.join(shot_dir, "last.json")


def _load_last(shot_dir: str) -> dict:
    """取上一张图的下落。没有就返回空字典，不抛异常。"""
    try:
        with open(_last_path(shot_dir), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_last(shot_dir: str, payload: dict) -> None:
    """记下这一张：路径、描述、时刻。屏幕没动时靠它把上一张原样递回去。"""
    record = {
        "path": payload.get("path", ""),
        "look": payload.get("look", ""),
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "kept_frames": payload.get("kept_frames", 0),
        "text": payload.get("text", {}),
    }
    path = _last_path(shot_dir)
    try:
        tmp = path + ".part"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception as exc:
        logger.warning("[see_now] 快照记不住：%s: %s", type(exc).__name__, exc)


def _sweep_old_shots(shot_dir: str, days: int = 3) -> None:
    """写入新图之前先扫一遍，把超过几天的老截图清掉。只删 .png。"""
    cutoff = time.time() - days * 86400
    try:
        names = os.listdir(shot_dir)
    except OSError:
        return
    for name in names:
        if not name.lower().endswith(".png"):
            continue
        fp = os.path.join(shot_dir, name)
        try:
            if os.path.getmtime(fp) < cutoff:
                os.remove(fp)
        except OSError:
            pass


def run_once(cfg: dict) -> dict:
    """抓一段 → 留帧 → 装箱 / 裁变化区 → 可选认字 → 返回一份 JSON 用的字典。"""
    span = max(2.0, min(60.0, float(cfg.get("seconds") or 10.0)))
    cap = max(1, min(12, int(cfg.get("max_frames") or 6)))
    tier_lock = int(cfg.get("tier_lock") or 0)
    tier_style = str(cfg.get("tier_style") or "native")
    if tier_style not in ("native", "up", "down"):
        tier_style = "native"
    focus = str(cfg.get("focus") or "auto")
    if focus not in ("whole", "content", "auto"):
        focus = "auto"
    max_width = int(cfg.get("max_width") or 1600)
    max_width = max(400, min(4096, max_width))
    shot_dir = str(cfg.get("shot_dir") or "")
    if not shot_dir:
        shot_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
    os.makedirs(shot_dir, exist_ok=True)

    # 锁档时抓多了也装不下，先按高度预算砍掉，省得白抓、白算一遍分。
    cap = min(cap, _frame_limit(tier_lock))

    t_start = time.time()
    shots, frames, last_raw, diff_pair, focus_note = _grab_run(
        span, cap, focus)

    # 整段一帧都没留下，说明屏幕基本没动。把上一张原样递回去，不重新拼、不重新识图。
    if not frames:
        last = _load_last(shot_dir)
        last_path = str(last.get("path") or "")
        if last_path and os.path.exists(last_path):
            logger.info("[see_now] 画面没变，复用 %s", os.path.basename(last_path))
            reuse = {
                "status": "ok",
                "path": last_path,
                "shot_frames": shots,
                "kept_frames": 0,
                "seconds": round(span, 1),
                "elapsed_ms": int((time.time() - t_start) * 1000),
                "reused": True,
                "look": last.get("look") or "",
                "note": ("这段时间画面几乎没动，一帧都没留，还是 %s 那一张。"
                         "如果用户问的是刚发生的事，可以再抓一次或让他自己说。"
                         % (last.get("at") or "上次")),
            }
            if last.get("text"):
                reuse["text"] = last["text"]
            return reuse
        # 头一回就撞上静止画面，只能兜底抓一张，否则交不出图。
        img, _ = _shot()
        frames = [(_big(img), CUT_ABS)]

    name = "see_now_" + time.strftime("%Y%m%d-%H%M%S") + ".png"
    path = os.path.join(shot_dir, name)
    _sweep_old_shots(shot_dir)

    # 只留下一帧时，先问一句「变的是哪块」。变化集中，就只把那块裁出来——
    # 模型那头会把整屏压到同一个 token 栅格，裁一小块反而换回一倍细节。
    crop = None
    crop_box = None
    if len(frames) == 1 and diff_pair and focus == "whole":
        crop_box = _changed_box(diff_pair[0], diff_pair[1])
        crop = _crop_for_model(diff_pair[1], crop_box)

    plan = None
    if crop is not None:
        if crop.width > max_width:
            ratio = max_width / float(crop.width)
            crop = crop.resize((max_width, max(1, int(crop.height * ratio))), Image.LANCZOS)
        crop.save(path)
        crop_note = "这张只裁了变化的区域（%d×%d），细节比整屏清楚。" % crop.size
    else:
        plan = _pack(frames, path, tier_style, tier_lock, max_width)
        crop_note = ""

    payload = {
        "status": "ok",
        "path": path,
        "shot_frames": shots,
        "kept_frames": len(frames),
        "seconds": round(span, 1),
        "elapsed_ms": int((time.time() - t_start) * 1000),
        "reused": False,
        "look": "",
        "note": ("抓了 %d 帧，只留 %d 帧（画面变化才留）。%s%s"
                 "识图不在这里做：图在 path，接着交给 WhaleLife 那头的视觉模型。"
                 % (shots, len(frames),
                    (focus_note + "。") if focus_note else "",
                    crop_note)),
    }
    tier_line = _tier_note(plan, tier_style, tier_lock)
    if tier_line:
        payload["tier"] = tier_line

    if cfg.get("text_layer"):
        # 认字只认「变的那块」：整屏六十行里大半是没动的字。装箱那张缩到三分之一，
        # 字早糊了，所以只借裁切图、不借装箱图。
        src_png = os.path.join(shot_dir, "_ocr_src.png")
        ocr_src = last_raw
        origin = (0, 0)
        if crop is not None and crop_box is not None:
            ocr_src = crop
            origin = (int(crop_box[0]), int(crop_box[1]))
        try:
            ocr_src.save(src_png)
            pack = _text_layer(src_png)
        finally:
            try:
                os.remove(src_png)
            except OSError:
                pass
        if isinstance(pack, dict) and pack.get("ok") and origin != (0, 0):
            # 坐标换回整屏，不然模型拿着裁剪图里的坐标去点，全偏到左上角。
            for line in pack.get("lines") or []:
                if isinstance(line, dict):
                    line["x"] = int(line.get("x") or 0) + origin[0]
                    line["y"] = int(line.get("y") or 0) + origin[1]
            pack["crop_origin"] = {"x": origin[0], "y": origin[1]}
        if isinstance(pack, dict) and pack.get("ok"):
            payload["text"] = pack
            payload["note"] += (" 另外 text.blocks 已经拼好：控件和字合成一份，"
                                "按屏幕从上到下、从左到右排过序，x/y 是整屏坐标。")

    _save_last(shot_dir, payload)
    logger.info("[see_now] %s 抓 %d 留 %d", name, shots, len(frames))
    return payload


def main(argv=None) -> int:
    import argparse

    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(prog="see_now_sidecar", add_help=True)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--max-frames", type=int, default=6)
    ap.add_argument("--tier-style", default="native", choices=["native", "up", "down"])
    ap.add_argument("--tier-lock", type=int, default=0)
    ap.add_argument("--focus", default="auto", choices=["whole", "content", "auto"])
    ap.add_argument("--max-width", type=int, default=1600)
    ap.add_argument("--shot-dir", default="")
    ap.add_argument("--text-layer", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)

    shot_dir = a.shot_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")

    if a.list:
        print(json.dumps({
            "ok": True,
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "pil": getattr(__import__("PIL"), "__version__", "?"),
            "shot_dir": shot_dir,
            "grab": True,
        }, ensure_ascii=False))
        return 0

    cfg = {
        "seconds": a.seconds,
        "max_frames": a.max_frames,
        "tier_style": a.tier_style,
        "tier_lock": a.tier_lock,
        "focus": a.focus,
        "max_width": a.max_width,
        "shot_dir": shot_dir,
        "text_layer": a.text_layer,
    }
    try:
        payload = run_once(cfg)
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"status": "error",
                          "message": "抓屏失败：%s: %s" % (type(exc).__name__, exc)},
                         ensure_ascii=False))
        return 1
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
