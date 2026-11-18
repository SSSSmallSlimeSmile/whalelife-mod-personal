/*! WhaleLife「生图」插件：把 ComfyUI 接成一个能手动启停的出图后端。
 *
 * 分工：
 *   comfy_sidecar.py   连 ComfyUI、推工作流、轮询、取图（同步，一次一进程）
 *   comfy_workflows.py 从旧库原样搬来的推断逻辑：导入任意 API 工作流后，
 *                      顺着 KSampler 的 positive/negative 连线认出哪条是正面、
 *                      哪条是负面，再找出种子和尺寸。不写死节点 id。
 *
 * 这边只管：管进程、查显存、把边车返回的 JSON 说成一句话。
 * 出图是长任务（本机 SDXL 60 秒），所以工具调用会等。
 *
 * 显存：ComfyUI 用 --lowvram 能把大模型挤进 8G 卡，但和语音合成抢的时候还是会爆。
 * 所以出图前先看剩余显存，低于 need_vram_mb 就报警，不硬跑。
 */
import type { Context } from "../../core/context.ts";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  /** 边车用哪个 Python。留空则按「配置 → WHALELIFE_COMFY_PYTHON → PATH 里的 python」找。 */
  python: "",
  script: join(HERE, "comfy_sidecar.py"),
  /** ComfyUI 服务地址。 */
  base_url: "http://127.0.0.1:8188",
  /** 出图落在插件的 out/ 下。 */
  output_dir: join(HERE, "out"),
  /** 工作流目录。 */
  workflows_dir: join(HERE, "workflows"),
  /** 单次出图最多等多少秒。 */
  timeout_seconds: 300,
  /** 出图前检查空闲显存，低于这个数（MiB）就报警，不硬跑。 */
  vram_guard: true,
  need_vram_mb: 3000,
  /** ComfyUI 本体：便携版根目录。启动时按这里的 layout 找解释器和 main.py。 */
  comfy_root: "",
  /** 启动参数：低显存模式把权重分块换进换出，8G 卡能跑 SDXL。 */
  launch_args: "--lowvram",
  /** WhaleLife 起来时自动拉起 ComfyUI。 */
  auto_start: false,
  /** WhaleLife 退出时一并关掉 ComfyUI。 */
  stop_on_exit: true,
};

type Config = typeof DEFAULTS;

type SidecarResult = {
  ok?: boolean;
  error?: string;
  version?: string;
  device?: string;
  vram_total?: number;
  vram_free?: number;
  running?: number;
  pending?: number;
  workflows?: Array<{
    name: string;
    nodes?: number;
    slots?: Array<{ name: string; kind?: string; mode?: string }>;
    output_node?: string;
    error?: string;
  }>;
  task_id?: string;
  image?: string;
  bytes?: number;
  seed?: number;
  applied?: string[];
};

/**
 * 找 Python：配置 → 环境变量 → PATH → 常见安装位置。
 *
 * PATH 里那个 WindowsApps\python.exe 是应用商店的占位符，跑起来只会弹商店，
 * 所以要跳过——不然命令「跑过了」，实际什么都没执行。
 * 返回空串表示真找不到，调用方会给出明确的报错。
 */
function resolvePython(cfgPath: string, comfyRoot?: string): string {
  const store = /[\\/]WindowsApps[\\/]/i;
  const want = String(cfgPath ?? "").trim();
  if (want && existsSync(want) && !store.test(want)) return want;
  if (want) console.warn(`[comfy] 配置的 python 用不了：${want}，继续往下找`);

  const envPath = String(process.env.WHALELIFE_COMFY_PYTHON ?? "").trim();
  if (envPath && existsSync(envPath) && !store.test(envPath)) return envPath;

  const sep = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const dir of String(process.env.PATH ?? "").split(sep)) {
    if (!dir || store.test(dir)) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }

  // ComfyUI 便携版自带一套 Python，边车只用标准库，用它最省事。
  const root = String(comfyRoot ?? "").trim();
  if (root) {
    for (const rel of [
      ["python_embeded", "python.exe"],
      ["python_embedded", "python.exe"],
      ["venv", "Scripts", "python.exe"],
    ]) {
      const p = join(root, ...rel);
      if (existsSync(p) && !store.test(p)) return p;
    }
  }

  const local = process.env.LOCALAPPDATA ?? "";
  const guesses = [
    "C:\\Python313\\python.exe",
    "C:\\Python312\\python.exe",
    "C:\\Python311\\python.exe",
    local ? join(local, "Programs", "Python", "Python313", "python.exe") : "",
    local ? join(local, "Programs", "Python", "Python312", "python.exe") : "",
    local ? join(local, "Programs", "Python", "Python311", "python.exe") : "",
  ].filter(Boolean);
  for (const g of guesses) if (existsSync(g) && !store.test(g)) return g;

  return "";
}

/** 跑一次边车，把 stdout 那一行 JSON 解出来。 */
function runSidecar(cfg: Config, args: string[], timeoutMs: number): Promise<SidecarResult> {
  const full = [
    cfg.script,
    "--base-url", String(cfg.base_url),
    "--workflows-dir", String(cfg.workflows_dir),
    "--output-dir", String(cfg.output_dir),
    "--timeout", String(timeoutMs / 1000),
    ...args,
  ];
  return new Promise((ok, fail) => {
    execFile(
      (() => {
        const py = resolvePython(cfg.python, cfg.comfy_root);
        if (!py) {
          throw new Error(
            "找不到 Python。请在插件页填一个 python.exe 的完整路径，" +
              "或设环境变量 WHALELIFE_COMFY_PYTHON。",
          );
        }
        return py;
      })(),
      full,
      {
        cwd: HERE,
        timeout: timeoutMs + 15_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      },
      (error, stdout, stderr) => {
        const line = String(stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
        if (line.startsWith("{")) {
          try {
            const parsed = JSON.parse(line) as SidecarResult;
            if (parsed.ok === false) return fail(new Error(parsed.error ?? "边车报错"));
            return ok(parsed);
          } catch {
            // 落到下面统一报
          }
        }
        const tail = String(stderr ?? "").trim().split("\n").slice(-2).join(" ");
        if (error) {
          const killed = (error as any).killed ? "（超时被杀）" : "";
          return fail(new Error(`${error.message}${killed}${tail ? "：" + tail : ""}`));
        }
        fail(new Error(tail || "边车没有返回可解析的 JSON"));
      },
    );
  });
}

/** 剩余显存（MiB）。查不到返回 null，宁可放过也不误杀。 */
function freeVramMiB(): number | null {
  try {
    const r = execFileSyncSafe("nvidia-smi", [
      "--query-gpu=memory.free",
      "--format=csv,noheader,nounits",
    ]);
    const n = Number(String(r).trim().split("\n")[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function execFileSyncSafe(cmd: string, args: string[]): string {
  // 用一个极短超时的同步调用，拿不到就当没有显卡信息。
  return String(execFileSync(cmd, args, { timeout: 5000, windowsHide: true, encoding: "utf-8" }));
}

/** 端口上有没有人在听。 */
function portOpen(url: string): Promise<boolean> {
  return new Promise((ok) => {
    try {
      const u = new URL(url);
      const sock = createConnection({ host: u.hostname, port: Number(u.port || 80) });
      sock.setTimeout(1200);
      sock.once("connect", () => {
        sock.destroy();
        ok(true);
      });
      sock.once("timeout", () => {
        sock.destroy();
        ok(false);
      });
      sock.once("error", () => ok(false));
    } catch {
      ok(false);
    }
  });
}

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = (await ctx.config.read("config.json")) as Partial<Config> | null;
  } catch {
    saved = null;
  }
  let cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };

  const reload = async () => {
    try {
      const again = (await ctx.config.read("config.json")) as Partial<Config> | null;
      cfg = { ...DEFAULTS, ...(again ?? {}) };
    } catch {
      // 读不到就沿用上一次
    }
  };

  let child: ChildProcess | null = null;

  const startComfy = async (): Promise<string> => {
    if (await portOpen(cfg.base_url)) return "ComfyUI 已经在跑，没有再起一个";
    const root = String(cfg.comfy_root ?? "").trim();
    const py = join(root, "python_embeded", "python.exe");
    const main = join(root, "ComfyUI", "main.py");
    if (!existsSync(py)) return `找不到 ComfyUI 的解释器：${py}`;
    if (!existsSync(main)) return `找不到 ComfyUI 的 main.py：${main}`;
    const args = [main, ...String(cfg.launch_args ?? "").split(/\s+/).filter(Boolean)];
    try {
      child = spawn(py, args, {
        cwd: join(root, "ComfyUI"),
        windowsHide: true,
        detached: false,
        stdio: "ignore",
      });
      child.on("exit", () => {
        child = null;
      });
      ctx.logger.info(`comfy 已拉起：pid=${child.pid} 参数=${args.slice(1).join(" ")}`);
      return `已启动（pid ${child.pid}），模型加载要几十秒`;
    } catch (error: any) {
      return `启动失败：${error?.message ?? error}`;
    }
  };

  const stopComfy = async (): Promise<string> => {
    try {
      const u = new URL(cfg.base_url);
      const port = Number(u.port || 80);
      const out = execFileSyncSafe("powershell", [
        "-NoProfile",
        "-Command",
        `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue;` +
          `if ($p) { $p.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force; $_ } }`,
      ]);
      const killed = String(out).trim().split(/\s+/).filter(Boolean);
      if (!killed.length) return `端口 ${port} 上本来就没有进程`;
      child = null;
      return `已结束 pid ${killed.join(", ")}`;
    } catch (error: any) {
      return `停止失败：${error?.message ?? error}`;
    }
  };

  mkdirSync(cfg.output_dir, { recursive: true });

  if (!existsSync(cfg.script)) ctx.logger.warn(`生图边车不在：${cfg.script}`);
  if (!existsSync(cfg.comfy_root)) ctx.logger.warn(`ComfyUI 目录不在：${cfg.comfy_root}`);

  if (cfg.auto_start && !(await portOpen(cfg.base_url))) {
    ctx.logger.info(await startComfy());
  }

  ctx.effect(() => () => {
    if (cfg.stop_on_exit && child) {
      try {
        child.kill();
        ctx.logger.info("comfy 已随 WhaleLife 关闭");
      } catch {
        // 杀不掉就算了，端口扫的时候还能清
      }
    }
  });

  ctx.tools.register({
    name: "comfy_status",
    description:
      "查 ComfyUI 在不在、装了什么设备、显存还剩多少、有哪些可用工作流。" +
      "出图之前想知道环境状态时用它；不返回图片。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      await reload();
      const up = await portOpen(cfg.base_url);
      if (!up) return `ComfyUI 没在跑（${cfg.base_url}）。可以在插件页按「启动服务」，或让 auto_start 打开。`;
      try {
        const [status, list] = await Promise.all([
          runSidecar(cfg, ["status"], 20_000),
          runSidecar(cfg, ["list"], 20_000),
        ]);
        const free = Number(status.vram_free ?? 0) / 1024 / 1024;
        const total = Number(status.vram_total ?? 0) / 1024 / 1024;
        const names = (list.workflows ?? []).map((w) => (w.error ? `${w.name}（${w.error}）` : w.name));
        return [
          `ComfyUI ${status.version ?? "?"} 在跑，设备 ${String(status.device ?? "").split(":")[0]}`,
          `显存 ${free.toFixed(0)} / ${total.toFixed(0)} MiB 空闲`,
          `队列 运行 ${status.running ?? 0} · 等 ${status.pending ?? 0}`,
          `工作流：${names.join("、") || "（空）"}`,
        ].join("\n");
      } catch (error: any) {
        return `错误：${error?.message ?? error}`;
      }
    },
  });

  ctx.tools.register({
    name: "comfy_generate",
    description:
      "用 ComfyUI 出一张图。要等几十秒（本机 SDXL 约一分钟），期间不会有别的输出。" +
      "工作流里哪些字段能填，先用 comfy_status 看；不填的字段保留工作流原值。" +
      "返回图片的本地路径，但那只是文件路径——看不到画面内容，要看得用 see_now 或让用户看。",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "正面提示词，英文效果更好" },
        negative: { type: "string", description: "负面提示词，可省略" },
        workflow: { type: "string", description: "工作流文件名，省略则用第一个" },
        width: { type: "number", description: "宽，省略保留工作流原值" },
        height: { type: "number", description: "高，省略保留工作流原值" },
        seed: { type: "number", description: "种子，省略则随机" },
        extra: { type: "object", description: "其它填写槽，键名照工作流的 slot 名" },
      },
      required: ["prompt"],
    },
    danger: "ask",
    run: async (args: any) => {
      await reload();
      if (!(await portOpen(cfg.base_url))) {
        return `ComfyUI 没在跑（${cfg.base_url}）。先在插件页启动服务。`;
      }
      if (cfg.vram_guard) {
        const free = freeVramMiB();
        if (free !== null && free < Number(cfg.need_vram_mb)) {
          return (
            `显存不够：只剩 ${free} MiB，低于阈值 ${cfg.need_vram_mb} MiB。` +
            "先停掉语音合成（嘴巴页或 voice 插件页有停止按钮），或者把出图尺寸调小。"
          );
        }
      }
      let name = String(args?.workflow ?? "").trim();
      if (!name) {
        const list = await runSidecar(cfg, ["list"], 20_000).catch(() => null);
        name = String(list?.workflows?.[0]?.name ?? "");
        if (!name) return "工作流目录里没有可用的 JSON";
      }
      const slots: Record<string, unknown> = { ...(args?.extra ?? {}) };
      if (args?.prompt) slots.positive_prompt = String(args.prompt);
      if (args?.negative) slots.negative_prompt = String(args.negative);
      if (args?.width) slots.width = Number(args.width);
      if (args?.height) slots.height = Number(args.height);

      // 用文件传 slots：命令行里带 JSON 会被 PowerShell 吃掉引号。
      const tmp = join(cfg.output_dir, `.slots-${Date.now()}.json`);
      try {
        writeFileSync(tmp, JSON.stringify(slots), "utf-8");
        const extra = ["generate", "--workflow", name, "--slots-file", tmp];
        if (args?.seed !== undefined && args?.seed !== null) extra.push("--seed", String(args.seed));
        const data = await runSidecar(cfg, extra, Number(cfg.timeout_seconds) * 1000);
        return [
          `出图完成（${name}）`,
          `文件：${data.image}`,
          `${(Number(data.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB · 种子 ${data.seed ?? "?"} · 填了 ${(data.applied ?? []).join("、")}`,
          "我看不到画面。要确认画了什么都不行的话，让用户看一眼，或者我再用 see_now 抓屏。",
        ].join("\n");
      } catch (error: any) {
        return `错误：${error?.message ?? error}`;
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // 删不掉无所谓
        }
      }
    },
  });

  /**
   * 看图：给一个本地图片路径，返回一张带「原图像素坐标」网格的图。
   *
   * 为什么要有这个工具：以前想看自己抓的图只能用 see_now（抓屏幕），
   * 拿到的是缩放后的屏幕坐标，和原图对不上，所以才补错位置。
   * 这里一次把裁剪、缩放、网格都换算好，坐标一律标成原图坐标。
   */
  const viewTool = {
    name: "image_view",
    description:
      "看图：给一个本地图片路径，直接返回这张图（可裁剪、可放大），图上带原图像素的坐标网格。" +
      "想确认自己刚出的图长什么样、想看某个局部细节时用它。" +
      "返回的网格刻度就是原图像素坐标，可以直接拿去做遮罩或继续出图。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "图片文件完整路径（PNG / JPEG / WebP）" },
        crop: { type: "string", description: "只看一块，写成 x,y,w,h，单位是原图像素；省略看整张" },
        scale: { type: "number", description: "放大倍数 1–12；省略则按 max_width 缩到合适大小" },
        max_width: { type: "number", description: "成品图最大宽度，默认 1024，范围 256–2048" },
        grid: { type: "number", description: "网格间距（原图像素），默认自动；填 0 不画网格" },
      },
      required: ["path"],
    },
    danger: "safe" as const,
    run: async (args: any) => {
      const raw = String(args?.path ?? "").trim();
      if (!raw) return { content: [{ type: "text" as const, text: "要给一个图片路径。" }], receipt: { ok: false, reason: "no path" } };
      const py = resolvePython(cfg.python, cfg.comfy_root);
      if (!py) {
        return {
          content: [{ type: "text" as const, text: "找不到 Python，看图用不了。在插件页填一个 python.exe 的完整路径，或设环境变量 WHALELIFE_COMFY_PYTHON。" }],
          receipt: { ok: false, reason: "no python" },
        };
      }
      const script = join(HERE, "image_view.py");
      if (!existsSync(script)) {
        return { content: [{ type: "text" as const, text: `看图脚本不在：${script}` }], receipt: { ok: false, reason: "no script" } };
      }
      const cli = [script, "--path", raw.replace(/^["']|["']$/g, ""), "--out-dir", cfg.output_dir];
      if (args?.crop) cli.push("--crop", String(args.crop));
      if (args?.scale) cli.push("--scale", String(args.scale));
      if (args?.max_width) cli.push("--max-width", String(args.max_width));
      if (args?.grid !== undefined && args?.grid !== null) cli.push("--grid", String(args.grid));

      const data = await new Promise<any>((ok, fail) => {
        execFile(
          py,
          cli,
          { cwd: HERE, timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" } },
          (error, stdout, stderr) => {
            const line = String(stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
            if (line.startsWith("{")) {
              try {
                const parsed = JSON.parse(line);
                if (parsed?.ok === false) return fail(new Error(parsed.error ?? "看图脚本报错"));
                return ok(parsed);
              } catch {
                // 落到下面统一报
              }
            }
            const tail = String(stderr ?? "").trim().split("\n").slice(-2).join(" ");
            fail(new Error(String(error?.message ?? "看图脚本没有返回可解析的 JSON") + (tail ? "：" + tail : "")));
          },
        );
      }).catch((error: any) => ({ __error: String(error?.message ?? error) }) as any);

      if (data?.__error) {
        return { content: [{ type: "text" as const, text: `看图失败：${data.__error}` }], receipt: { ok: false, reason: data.__error } };
      }

      const src = data.src ?? {};
      const crop = data.crop ?? {};
      const grid = data.grid ?? {};
      const out = data.out ?? {};
      const lines = [
        `原图 ${src.w}x${src.h}；显示区域 x=${crop.x} y=${crop.y} w=${crop.w} h=${crop.h}` +
          (crop.clamped ? "（请求的范围超出了图，已被夹到边界内）" : ""),
        `缩放 x${data.scale}，成品 ${out.w}x${out.h}，${(Number(out.bytes ?? 0) / 1024).toFixed(0)} KB`,
        grid.step
          ? `网格间距 ${grid.step} px：竖线上的数字是原图的 x（${(grid.x ?? []).join("、")}），横线上的数字是原图的 y（${(grid.y ?? []).join("、")}）`
          : "没有画网格",
        "图上的刻度就是原图像素坐标，报位置、做遮罩都按这个数来。",
        `文件：${data.path}`,
      ];
      if (data.compressed) lines.push("（图偏大，已压成 256 色以控制在 4 MiB 内）");

      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "image" as const, mimeType: "image/png" as const, data: new Uint8Array(readFileSync(String(data.path))), detail: "high" as const },
        ],
        receipt: { ok: true, path: String(data.path), crop: `${crop.x},${crop.y},${crop.w},${crop.h}`, scale: data.scale },
      };
    },
  };

  if (typeof (ctx.tools as any).registerMultimodal === "function") {
    (ctx.tools as any).registerMultimodal(viewTool);
    ctx.logger.info("comfy 已注册 image_view（工具能直接返回图片）");
  } else {
    ctx.logger.warn("当前宿主没有 registerMultimodal，image_view 未注册（peek 的看图提示会失效）");
  }

  ctx.web.page(
    "/plugins/comfy/",
    async (_req, res) => {
      await reload();
      const up = await portOpen(cfg.base_url);
      let workflows: string[] = [];
      let health: { version?: string; free?: number; total?: number } = {};
      if (up) {
        try {
          const list = await runSidecar(cfg, ["list"], 15_000);
          workflows = (list.workflows ?? []).filter((w) => !w.error).map((w) => w.name);
        } catch {
          // 列表拉不到就空着
        }
        try {
          const st = await runSidecar(cfg, ["status"], 15_000);
          health = {
            version: st.version,
            free: Number(st.vram_free ?? 0) / 1024 / 1024,
            total: Number(st.vram_total ?? 0) / 1024 / 1024,
          };
        } catch {
          // 状态拉不到就空着
        }
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg, { up, workflows, health, vramFree: freeVramMiB() }));
    },
    { title: "生图", navigation: true },
  );

  ctx.web.api("/plugins/comfy/save", async (req, res) => {
    try {
      const patchIn = sanitize(await readBody(req));
      const keys = Object.keys(patchIn);
      if (!keys.length) throw new Error("没有可保存的字段");
      const merged = { ...(await ctx.config.read<any>("config.json").catch(() => null)), ...patchIn };
      await ctx.config.save("config.json", merged);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, saved: keys }));
    } catch (error: any) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
    }
  });

  ctx.web.api("/plugins/comfy/service", async (req, res) => {
    const body = await readBody(req).catch(() => ({}) as any);
    const action = String((body as any)?.action ?? "");
    const message = action === "start" ? await startComfy() : action === "stop" ? await stopComfy() : "不懂这个动作";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, message }));
  });

  ctx.logger.info("comfy 已加载");
}
