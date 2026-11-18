"""ComfyUI 边车：列工作流、推断填写项、提交出图、取回图片。

只用标准库，不依赖 requests / aiohttp。
一次调用做一件事，结果以 JSON 打到 stdout，人读的说明走 stderr。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comfy_workflows import (  # noqa: E402
    WorkflowError,
    WorkflowStore,
    fill_workflow,
    fingerprint,
    infer_mapping,
    validate_mapping,
)

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

MAX_BYTES = 8 * 1024 * 1024


def emit(value) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.write("\n")


def fail(message: str, code: int = 1) -> "NoReturn":  # noqa: F821
    emit({"ok": False, "error": message})
    sys.exit(code)


class Client:
    def __init__(self, base: str, timeout: float) -> None:
        base = (base or "").strip().rstrip("/")
        if base and "://" not in base:
            base = "http://" + base
        if not base:
            raise WorkflowError("没有填写 ComfyUI 地址")
        self.base = base
        self.timeout = timeout

    def request(self, method: str, path: str, payload=None):
        url = self.base + path
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise WorkflowError("ComfyUI 返回内容过大")
        except urllib.error.HTTPError as exc:
            body = exc.read(MAX_BYTES) if exc.fp else b""
            detail = ""
            try:
                parsed = json.loads(body) if body else {}
                nodes = parsed.get("node_errors") or {}
                if nodes:
                    detail = "，错误节点：" + ", ".join(str(k) for k in nodes)
                elif parsed.get("error"):
                    detail = "，" + str(parsed["error"].get("message") or parsed["error"])[:200]
            except Exception:
                pass
            raise WorkflowError(f"ComfyUI 请求失败（HTTP {exc.code}）{detail}") from exc
        except urllib.error.URLError as exc:
            raise WorkflowError(f"连不上 ComfyUI（{self.base}）：{exc.reason}") from exc
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise WorkflowError("ComfyUI 返回的不是 JSON") from exc

    def system_stats(self):
        return self.request("GET", "/system_stats")

    def queue(self):
        return self.request("GET", "/queue")


def build_store(workflows_dir: str) -> WorkflowStore:
    root = Path(workflows_dir)
    if not root.is_dir():
        raise WorkflowError(f"工作流目录不存在：{root}")
    names = [p.name for p in root.glob("*.json")]
    if not names:
        raise WorkflowError("工作流目录里没有 json")
    return WorkflowStore(root, [{"name": n, "path": str(root / n)} for n in names])


def resolve_mapping(store: WorkflowStore, name: str):
    """先用磁盘上存过的映射，没有就现推。工作流改了会拒绝旧映射。"""
    workflow = store.load(name)
    stamp = fingerprint(workflow)
    path = store.root.parent / "data" / "mappings" / (stamp[:16] + ".json")
    if path.exists():
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            return workflow, validate_mapping(workflow, record["mapping"]), stamp, path, True
        except Exception:
            pass
    mapping = validate_mapping(workflow, infer_mapping(workflow))
    return workflow, mapping, stamp, path, False


def save_mapping(path: Path, stamp: str, mapping) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"fingerprint": stamp, "mapping": mapping}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def cmd_status(args) -> None:
    client = Client(args.base_url, args.timeout)
    stats = client.system_stats()
    queue = client.queue()
    emit(
        {
            "ok": True,
            "base_url": client.base,
            "version": (stats.get("system") or {}).get("comfyui_version", ""),
            "device": (stats.get("devices") or [{}])[0].get("name", ""),
            "vram_total": (stats.get("devices") or [{}])[0].get("vram_total", 0),
            "vram_free": (stats.get("devices") or [{}])[0].get("vram_free", 0),
            "running": len(queue.get("queue_running") or []),
            "pending": len(queue.get("queue_pending") or []),
        }
    )


def cmd_list(args) -> None:
    store = build_store(args.workflows_dir)
    items = []
    for name in store.names():
        try:
            workflow, mapping, stamp, _, cached = resolve_mapping(store, name)
            items.append(
                {
                    "name": name,
                    "nodes": len(workflow),
                    "fingerprint": stamp,
                    "cached": cached,
                    "output_node": mapping.get("output_node", ""),
                    "slots": [
                        {
                            "name": key,
                            "kind": value.get("kind"),
                            "mode": value.get("mode"),
                            "node": value.get("node_id"),
                            "field": value.get("input_name"),
                        }
                        for key, value in mapping["fields"].items()
                    ],
                }
            )
        except Exception as exc:
            items.append({"name": name, "error": str(exc)})
    emit({"ok": True, "workflows": items})


def cmd_inspect(args) -> None:
    store = build_store(args.workflows_dir)
    workflow, mapping, stamp, _, cached = resolve_mapping(store, args.workflow)
    emit(
        {
            "ok": True,
            "workflow": args.workflow,
            "nodes": len(workflow),
            "fingerprint": stamp,
            "cached": cached,
            "output_node": mapping.get("output_node", ""),
            "slots": mapping["fields"],
        }
    )


def pick_image(history_item):
    outputs = history_item.get("outputs") or {}
    for node_id, block in outputs.items():
        for image in block.get("images") or []:
            if image.get("type") in (None, "output") and image.get("filename"):
                return image
    return None


def cmd_generate(args) -> None:
    store = build_store(args.workflows_dir)
    workflow, mapping, stamp, mapping_path, cached = resolve_mapping(store, args.workflow)
    raw = args.slots
    if args.slots_file:
        raw = io.open(args.slots_file, encoding="utf-8").read()
    slots = json.loads(raw) if raw.strip() else {}
    if args.seed is not None and "seed" in mapping["fields"]:
        slots["seed"] = int(args.seed)
    elif "seed" in mapping["fields"] and "seed" not in slots:
        slots["seed"] = random.randint(0, 2**31 - 1)
    filled = fill_workflow(workflow, mapping, slots)

    client = Client(args.base_url, args.timeout)
    response = client.request(
        "POST", "/prompt", {"client_id": "whalelife-" + uuid.uuid4().hex, "prompt": filled}
    )
    task_id = str(response.get("prompt_id") or "")
    if not task_id:
        raise WorkflowError("ComfyUI 没给任务编号")

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        history = client.request("GET", "/history/" + urllib.parse.quote(task_id, safe=""))
        item = history.get(task_id)
        if item:
            status = item.get("status") or {}
            if status.get("status_str") in ("error", "failed"):
                raise WorkflowError("出图失败，看 ComfyUI 控制台")
            image = pick_image(item)
            if image:
                query = urllib.parse.urlencode(
                    {"filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": image.get("type", "output")}
                )
                url = client.base + "/view?" + query
                out_dir = Path(args.output_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                target = out_dir / image["filename"]
                with urllib.request.urlopen(url, timeout=args.timeout) as resp:
                    target.write_bytes(resp.read(MAX_BYTES))
                emit(
                    {
                        "ok": True,
                        "task_id": task_id,
                        "image": str(target),
                        "bytes": target.stat().st_size,
                        "seed": slots.get("seed"),
                        "applied": sorted(slots.keys()),
                        "mapping_cached": cached,
                    }
                )
                return
        time.sleep(1.0)
    raise WorkflowError(f"等了 {args.timeout} 秒还没出图")


def build_parser() -> argparse.ArgumentParser:
    """公共参数在子命令前后都能写，省得调用方记顺序。"""
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", default="http://127.0.0.1:8188")
    common.add_argument("--workflows-dir", default=str(Path(__file__).parent / "workflows"))
    common.add_argument("--output-dir", default=str(Path(__file__).parent / "out"))
    common.add_argument("--timeout", type=float, default=300)

    parser = argparse.ArgumentParser(parents=[common])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", parents=[common])
    sub.add_parser("list", parents=[common])
    p = sub.add_parser("inspect", parents=[common])
    p.add_argument("--workflow", required=True)
    p = sub.add_parser("generate", parents=[common])
    p.add_argument("--workflow", required=True)
    p.add_argument("--slots", default="{}")
    p.add_argument("--slots-file", default="")
    p.add_argument("--seed", type=int, default=None)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        {"status": cmd_status, "list": cmd_list, "inspect": cmd_inspect, "generate": cmd_generate}[
            args.cmd
        ](args)
    except WorkflowError as exc:
        fail(str(exc))
    except Exception as exc:  # noqa: BLE001
        fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
