/*! WhaleLife「看屏」插件：按变化取帧。
 *
 * 抓屏、判分、留帧、装箱、认字全在 Python 边车里（沿用上游那份 941 行主线，
 * 只把 AstrBot 插件壳换成了命令行）。这边只管三件事：
 *   拉起边车、读回 JSON、把拼好的图交给本地视觉模型说一遍。
 *
 * 与 eyes 的区别：eyes 只看当前一帧；这里抓一段，只为「画面变了」的帧付 token。
 */
import type { Context } from "../../core/context.ts";
import { execFile, spawnSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  /** 边车用哪个 Python。留空则按「配置 → WHALELIFE_PEEK_PYTHON → PATH 里的 python」找。 */
  python: "",
  script: join(HERE, "see_now_sidecar.py"),
  shot_dir: join(HERE, "shots"),
  /** 抓多久，秒。 */
  seconds: 10,
  /** 一张图最多装几帧。 */
  max_frames: 6,
  /** native / up / down —— 档位整体偏移。 */
  tier_style: "native",
  /** 1-3 锁死一档，0 不锁。 */
  tier_lock: 0,
  /** whole / content / auto —— auto 先整屏抓，热点占屏 8%-60% 才裁。 */
  focus: "auto",
  /** 成品图与单帧裁切图的最大宽度，400-4096。 */
  max_width: 1600,
  /** UIA + OCR 认一次字，慢，默认关。 */
  text_layer: false,
  /** 视觉模型：本地 ollama。 */
  vision_model: "qwen3-vl:4b",
  ollama: "http://127.0.0.1:11434",
  vision_timeout_ms: 120_000,
  /** 边车总超时：抓多久 + 装箱 + 认字，留足余量。 */
  run_timeout_ms: 180_000,
};

type Config = typeof DEFAULTS;

type SidecarResult = {
  status?: string;
  message?: string;
  path?: string;
  shot_frames?: number;
  kept_frames?: number;
  seconds?: number;
  elapsed_ms?: number;
  reused?: boolean;
  look?: string;
  note?: string;
  tier?: string;
  text?: {
    ok?: boolean;
    window?: string;
    text?: string;
    blocks?: Array<{ k?: string; t?: string; r?: string; x?: number; y?: number }>;
    element_count?: number;
    line_count?: number;
    ocr_lang?: string;
  };
};

/** 找 Python：配置里的路径 → 环境变量 WHALELIFE_PEEK_PYTHON → PATH 里的 python。 */
function resolvePython(cfgPath: string): string {
  const want = String(cfgPath ?? "").trim();
  if (want && existsSync(want)) return want;
  if (want) console.warn(`[peek] 配置的 python 不存在：${want}，继续往下找`);
  const envPath = String(process.env.WHALELIFE_PEEK_PYTHON ?? "").trim();
  if (envPath && existsSync(envPath)) return envPath;
  if (envPath) console.warn(`[peek] WHALELIFE_PEEK_PYTHON 指向的文件不存在：${envPath}`);
  return "python";
}

/** 跑一次边车，把 stdout 的那一行 JSON 解出来。 */
function runSidecar(cfg: Config, seconds: number, maxFrames: number, maxWidth: number): Promise<SidecarResult> {
  const args = [
    cfg.script,
    "--seconds", String(seconds),
    "--max-frames", String(maxFrames),
    "--tier-style", String(cfg.tier_style),
    "--tier-lock", String(cfg.tier_lock),
    "--focus", String(cfg.focus),
    "--max-width", String(maxWidth),
    "--shot-dir", String(cfg.shot_dir),
  ];
  if (cfg.text_layer) args.push("--text-layer");

  return new Promise((ok, fail) => {
    execFile(
      resolvePython(cfg.python),
      args,
      {
        cwd: HERE,
        timeout: cfg.run_timeout_ms,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "").trim();
        const line = out.split(/\r?\n/).filter((s) => s.trim().startsWith("{")).pop();
        if (line) {
          try {
            const data = JSON.parse(line) as SidecarResult;
            if (data.status === "error") {
              fail(new Error(data.message || "边车报错（没给原因）"));
              return;
            }
            ok(data);
            return;
          } catch (error: any) {
            fail(new Error(`边车输出不是 JSON：${error?.message ?? error}`));
            return;
          }
        }
        const tail = String(stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" / ");
        fail(
          new Error(
            err
              ? `边车没跑成（${(err as any)?.code ?? err?.message}）${tail ? "：" + tail : ""}`
              : "边车没有任何输出",
          ),
        );
      },
    );
  });
}

/** 把拼好的图交给本地视觉模型说一遍。 */
async function describe(cfg: Config, file: string, question: string): Promise<string> {
  const b64 = (await readFile(file)).toString("base64");
  const prompt =
    "这几张图是按时间顺序从屏幕上抓的，拼成一张；格子越大，说明那一刻画面变化越大。" +
    "直接说结论：屏幕上在干什么、打开了什么窗口、有什么文字或报错。" +
    (question ? `另外回答这个问题：${question}` : "") +
    "只描述看得见的，不要猜。不超过 250 字。";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.vision_timeout_ms);
  try {
    const res = await fetch(`${cfg.ollama}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.vision_model,
        prompt,
        images: [b64],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`视觉模型返回 HTTP ${res.status}`);
    const data: any = await res.json();
    const text = String(data?.response ?? "").trim();
    if (!text) throw new Error("视觉模型没有返回描述");
    return text;
  } catch (error: any) {
    if (controller.signal.aborted) throw new Error("视觉模型响应超时");
    throw new Error(`连不上本地 ollama（${cfg.ollama}）：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = (await ctx.config.read("config.json")) as Partial<Config> | null;
  } catch {
    saved = null;
  }
  let cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };

  /** 每次调用重读配置：改 config.json 不用重启进程。 */
  const reload = async () => {
    try {
      const again = (await ctx.config.read("config.json")) as Partial<Config> | null;
      cfg = { ...DEFAULTS, ...(again ?? {}) };
    } catch {
      // 读不到就沿用上一次那份
    }
  };

  try {
    await mkdir(cfg.shot_dir, { recursive: true });
  } catch {
    // 建不出来也先别拦，边车那边会自己报
  }
  if (!existsSync(resolve(cfg.script))) {
    ctx.logger.warn(`看屏边车不在：${cfg.script}`);
  }

  ctx.tools.register({
    name: "see_now",
    description:
      "抓一段屏幕（默认 10 秒），只保留画面真正变化的那几帧，拼成一张图后看图说话。" +
      "问「我在干嘛」「屏幕上是什么」「刚才弹出什么了」「这个界面有什么」时用它。" +
      "画面不动的时间几乎不留帧，所以不用担心浪费；但一次要等几秒到十几秒。",
    schema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "抓多久，默认 10 秒，范围 2-60" },
        max_frames: { type: "number", description: "一张图最多装几帧，默认 6，范围 1-12" },
        max_width: { type: "number", description: "成品图最大宽度，默认 1600，范围 400-4096" },
        question: { type: "string", description: "想重点看什么，可省略" },
      },
      required: [],
    },
    danger: "safe",
    run: async (args: any) => {
      const seconds = Math.max(2, Math.min(60, Number(args?.seconds ?? cfg.seconds) || cfg.seconds));
      const maxFrames = Math.max(1, Math.min(12, Number(args?.max_frames ?? cfg.max_frames) || cfg.max_frames));
      const maxWidth = Math.max(400, Math.min(4096, Number(args?.max_width ?? cfg.max_width) || cfg.max_width));
      const question = String(args?.question ?? "").trim();
      await reload();

      let data: SidecarResult;
      try {
        data = await runSidecar(cfg, seconds, maxFrames, maxWidth);
      } catch (error: any) {
        return `错误：${error?.message ?? String(error)}`;
      }

      const file = String(data.path ?? "");
      const head = [
        `抓 ${data.shot_frames ?? 0} 帧，留 ${data.kept_frames ?? 0} 帧，${data.seconds ?? seconds} 秒`,
        data.tier ? `档位：${data.tier}` : "",
      ]
        .filter(Boolean)
        .join("｜");

      // 屏幕几乎没动：边车把上一张原样递回来了，不重复识图。
      if (data.reused) {
        const reuseLook = String(data.look ?? "").trim();
        return [
          head,
          `图：${file}（复用上次那张）`,
          reuseLook ? `上次的描述：${reuseLook}` : "",
          data.note ?? "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      const parts = [head, `图：${file}`];

      const window = String(data.text?.window ?? "").trim();
      const blocks = data.text?.blocks ?? [];
      if (data.text?.ok && (window || blocks.length)) {
        const lines = blocks
          .slice(0, 40)
          .map((b) => (b.t ? String(b.t) : ""))
          .filter(Boolean);
        parts.push(
          `文字层（UIA + OCR${data.text.ocr_lang ? "，" + data.text.ocr_lang : ""}）` +
            (window ? `｜窗口：${window}` : "") +
            (lines.length ? "\n" + lines.join(" / ") : ""),
        );
      }

      if (!file || !existsSync(file)) {
        parts.push("没有出图，这部分没看成。");
        return parts.join("\n");
      }

      try {
        const text = await describe(cfg, file, question);
        parts.push(`屏幕描述（${cfg.vision_model}）：\n${text}`);
      } catch (error: any) {
        parts.push(`图出来了但没识成：${error?.message ?? String(error)}`);
      }
      if (data.note) parts.push(`边车备注：${data.note}`);
      return parts.join("\n");
    },
  });

  ctx.web.api("/plugins/peek/test", async (_req: any, res: any) => {
    const reply = (code: number, body: any) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const lines: string[] = [];
    let ok = true;
    try {
      await reload();

      // 1. python 起不起得来
      const py = resolvePython(cfg.python);
      try {
        const out = spawnSync(py, ["-c", "import sys; print(sys.version.split()[0])"], { timeout: 15000, encoding: "utf8" });
        if (out.error || out.status !== 0) {
          ok = false;
          lines.push(`[×] Python：${py} 调不动 —— ${out.error?.message ?? String(out.stderr ?? "").trim() ?? ("退出码 " + out.status)}`);
        } else {
          lines.push(`[✓] Python ${String(out.stdout ?? "").trim()}：${py}`);
        }
      } catch (error: any) {
        ok = false;
        lines.push(`[×] Python：${py} 调不动 —— ${error?.message ?? error}`);
      }

      // 2. 边车脚本在不在
      const script = resolve(cfg.script);
      if (existsSync(script)) lines.push(`[✓] 边车脚本：${script}`);
      else { ok = false; lines.push(`[×] 边车脚本不在：${script}`); }

      // 3. 视觉模型在不在 ollama 里
      try {
        const r = await fetch(`${cfg.ollama}/api/tags`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: any = await r.json();
        const names: string[] = (data?.models ?? []).map((m: any) => String(m?.name ?? ""));
        const want = String(cfg.vision_model ?? "");
        const hit = names.includes(want) || names.includes(want + ":latest") || names.some((n) => n.startsWith(want + ":"));
        if (hit) lines.push(`[✓] 视觉模型 ${want} 在 ollama 里（共 ${names.length} 个模型）`);
        else {
          ok = false;
          lines.push(`[×] 视觉模型 ${want} 不在 ollama 里。现有：${names.slice(0, 8).join("、") || "一个都没有"}`);
        }
      } catch (error: any) {
        ok = false;
        lines.push(`[×] 连不上 ollama（${cfg.ollama}）：${error?.message ?? error}`);
      }

      // 4. 出图目录能不能建
      try {
        await mkdir(cfg.shot_dir, { recursive: true });
        lines.push(`[✓] 出图目录：${cfg.shot_dir}`);
      } catch (error: any) {
        ok = false;
        lines.push(`[×] 出图目录建不出来：${cfg.shot_dir} —— ${error?.message ?? error}`);
      }

      lines.push("");
      lines.push("这只是配置检查。真要出图，用 see_now 抓一段。");
      return reply(200, { ok, lines });
    } catch (error: any) {
      return reply(500, { ok: false, lines: [`检查本身出错：${error?.message ?? error}`] });
    }
  });

  ctx.web.page(
    "/plugins/peek/",
    async (_req, res) => {
      await reload();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg));
    },
    { title: "看屏", navigation: true },
  );

  ctx.web.api("/plugins/peek/save", async (req, res) => {
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

  ctx.effect(() => () => {
    ctx.logger.info("peek 已清理");
  });
}
