/*! WhaleLife「看屏」插件：按变化取帧。
 *
 * 抓屏、判分、留帧、装箱、认字全在 Python 边车里（沿用上游那份 941 行主线，
 * 只把 AstrBot 插件壳换成了命令行）。这边只管三件事：
 *   拉起边车、读回 JSON、把拼好的图交给识图模型说一遍。
 *
 * 识图走哪条路可配：默认交给对话模型（跟随当前会话，或指定某一个），
 * 也可以走本地 Ollama。对话模型看不了图时自动退回本地 Ollama 再试一次。
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
  /** 识图走哪条路：chat = 对话模型（默认），ollama = 本地。 */
  vision_mode: "chat",
  /** 对话模型的配置 id。留空则跟随当前会话的人格模型。 */
  vision_model: "",
  /** 本地 Ollama 里的视觉模型名，也是对话模型看不了图时的退路。 */
  ollama_model: "qwen3-vl:4b",
  ollama: "http://127.0.0.1:11434",
  /** 本地识图之前先看显存够不够：小显卡上 4B 模型能把整张卡挤爆。 */
  vram_guard: true,
  /** 加载本地视觉模型至少要多少空闲显存（MiB）。 */
  need_vram_mb: 5200,
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

function buildPrompt(question: string): string {
  return (
    "这几张图是按时间顺序从屏幕上抓的，拼成一张；格子越大，说明那一刻画面变化越大。" +
    "直接说结论：屏幕上在干什么、打开了什么窗口、有什么文字或报错。" +
    (question ? `另外回答这个问题：${question}` : "") +
    "只描述看得见的，不要猜。不超过 250 字。"
  );
}

/** 可用作识图的对话模型：宿主登记过、且内核能直接调用。 */
function chatModels(ctx: Context): Array<{ id: string; name: string; model: string }> {
  try {
    return ctx.models
      .list("chat")
      .filter((m) => m.callable !== false)
      .map((m) => ({ id: m.id, name: m.name, model: m.model }));
  } catch {
    return [];
  }
}

/** 这次识图用哪个对话模型：配置指定 → 当前会话人格的模型 → 列表里第一个能用的。 */
function pickChatModel(ctx: Context, cfg: Config, session: any): { id: string; label: string } | null {
  const all = chatModels(ctx);
  const want = String(cfg.vision_model ?? "").trim();
  if (want) {
    const hit = all.find((m) => m.id === want) ?? all.find((m) => m.model === want) ?? all.find((m) => m.name === want);
    if (hit) return { id: hit.id, label: `${hit.name}（${hit.model}）` };
    console.warn(`[peek] 配置的对话模型 ${want} 不在可用列表里，改用当前会话的模型`);
  }
  const personaId = String(session?.personaId ?? "").trim();
  if (personaId) {
    try {
      const persona = ctx.personas.list().find((p) => p.id === personaId);
      const bound = String(persona?.model ?? "").trim();
      if (bound) {
        const hit = all.find((m) => m.id === bound);
        if (hit) return { id: hit.id, label: `${hit.name}（${hit.model}）` };
      }
    } catch {
      // 拿不到人格就当没指定，往下走
    }
  }
  const first = all[0];
  return first ? { id: first.id, label: `${first.name}（${first.model}）` } : null;
}

/** 旧配置里 vision_mode 还没写，而 vision_model 填的是 Ollama 的模型名：按本地处理，别把人家的配置改坏。 */
function visionMode(ctx: Context, cfg: Config): "chat" | "ollama" {
  const raw = String((cfg as any).vision_mode ?? "").trim().toLowerCase();
  if (raw === "chat" || raw === "ollama") return raw;
  const want = String(cfg.vision_model ?? "").trim();
  if (!want) return "chat";
  const hit = chatModels(ctx).some((m) => m.id === want || m.model === want);
  return hit ? "chat" : "ollama";
}

/** 交给对话模型看图。 */
async function describeChat(
  ctx: Context,
  modelId: string,
  cfg: Config,
  file: string,
  question: string,
): Promise<string> {
  const b64 = (await readFile(file)).toString("base64");
  const reply = await ctx.llm.chat({
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(question) },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    max_tokens: 2000,
    signal: AbortSignal.timeout(cfg.vision_timeout_ms),
  });
  const text = String(reply?.text ?? "").trim();
  if (!text) {
    const pt = Number(reply?.usage?.prompt_tokens ?? 0);
    const why =
      reply?.finish_reason === "length"
        ? "正文还没开始就被输出上限截断（思考把额度吃完了）"
        : pt > 0 && pt < 1000
          ? `图片多半没送进去（这次提示只有 ${pt} token）`
          : reply?.reasoning_content
            ? "只返回了思考内容，没有正文"
            : "返回了空内容，多半是这个模型不支持图片输入";
    throw new Error(`对话模型没有返回描述：${why}`);
  }
  return text;
}

/** 问一次 nvidia-smi：现在还剩多少空闲显存（MiB）。查不到返回 null。 */
function freeVramMb(): number | null {
  const r = spawnSync("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const n = parseInt(String(r.stdout ?? "").trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** 本地那条路能不能走。不够就别硬加载，把话说清楚交给调用方。 */
function vramShort(cfg: Config): string | null {
  if (!cfg.vram_guard) return null;
  const free = freeVramMb();
  // 查不到就不拦——没装 nvidia-smi 的机器不该被这一条误伤。
  if (free === null) return null;
  if (free >= cfg.need_vram_mb) return null;
  return (
    `本地显存不够：只剩 ${free} MiB，加载 ${cfg.ollama_model} 至少要 ${cfg.need_vram_mb} MiB。` +
    `关掉别的东西再试，或者把识图改成走对话模型。`
  );
}

/** 交给本地 Ollama 看图。 */
async function describeOllama(cfg: Config, model: string, file: string, question: string): Promise<string> {
  // 放在 try 外面：显存不够不是「连不上」，别被下面的兜底包成连接错误。
  const short = vramShort(cfg);
  if (short) throw new Error(short);
  const b64 = (await readFile(file)).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.vision_timeout_ms);
  try {
    const res = await fetch(`${cfg.ollama}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildPrompt(question),
        images: [b64],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`本地 Ollama 返回 HTTP ${res.status}`);
    const data: any = await res.json();
    const text = String(data?.response ?? "").trim();
    if (!text) throw new Error("本地 Ollama 没有返回描述");
    return text;
  } catch (error: any) {
    if (controller.signal.aborted) throw new Error("本地 Ollama 响应超时");
    if (String(error?.message ?? "").startsWith("本地 Ollama")) throw error;
    throw new Error(`连不上本地 Ollama（${cfg.ollama}）：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 识图总入口：按配置选路，失败就换另一条再试一次，不直接扔错误给模型。 */
async function describe(
  ctx: Context,
  cfg: Config,
  session: any,
  file: string,
  question: string,
): Promise<{ text: string; by: string; note?: string }> {
  const mode = visionMode(ctx, cfg);
  if (mode === "chat") {
    const pick = pickChatModel(ctx, cfg, session);
    if (!pick) {
      const text = await describeOllama(cfg, cfg.ollama_model, file, question);
      return { text, by: cfg.ollama_model, note: "没有可用的对话模型，走了本地" };
    }
    try {
      const text = await describeChat(ctx, pick.id, cfg, file, question);
      return { text, by: pick.label };
    } catch (error: any) {
      const first = String(error?.message ?? error);
      try {
        const text = await describeOllama(cfg, cfg.ollama_model, file, question);
        return { text, by: cfg.ollama_model, note: `对话模型没成（${first}），已退回本地` };
      } catch (fallback: any) {
        throw new Error(
          `对话模型 ${pick.label} 没成：${first}；本地 ${cfg.ollama_model} 也没成：${fallback?.message ?? fallback}`,
        );
      }
    }
  }
  const text = await describeOllama(cfg, cfg.ollama_model, file, question);
  return { text, by: cfg.ollama_model };
}

/** plugins.json 的 disabled 里没有 eyes，就算它开着。读不到也按开着算，宁可多提醒一次。 */
async function eyesRunning(): Promise<boolean> {
  try {
    const raw = await readFile(join(HERE, "..", "..", "config", "plugins.json"), "utf8");
    const list = JSON.parse(raw)?.disabled;
    return !(Array.isArray(list) && list.includes("eyes"));
  } catch {
    return true;
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
  if (await eyesRunning()) {
    ctx.logger.warn(
      "eyes 和 peek 同时启用：两者都要用本地视觉模型，显存不够会把整机挤到卡死。建议在插件管理里停用 eyes。",
    );
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
    run: async (args: any, session: any) => {
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
        const look = await describe(ctx, cfg, session, file, question);
        parts.push(`屏幕描述（${look.by}）：\n${look.text}`);
        if (look.note) parts.push(`说明：${look.note}`);
      } catch (error: any) {
        parts.push(`图出来了但没识成：${error?.message ?? String(error)}`);
      }
      if (data.note) parts.push(`边车备注：${data.note}`);
      return parts.join("\n");
    },
  });

  ctx.web.api("/plugins/peek/test", async (req: any, res: any) => {
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

      // 3. 识图这条路通不通
      const mode = visionMode(ctx, cfg);
      if (mode === "chat") {
        const all = chatModels(ctx);
        const pick = pickChatModel(ctx, cfg, null);
        if (!pick) {
          ok = false;
          lines.push(`[×] 识图：没有可用的对话模型，只能退回本地 Ollama（${cfg.ollama_model}）`);
        } else {
          lines.push(`[✓] 识图走对话模型：${pick.label}（共 ${all.length} 个可用对话模型）`);
          if (!String(cfg.vision_model ?? "").trim()) {
            lines.push("    没指定模型时，会跟随当前会话的人格模型；我这里看不到会话，就用列表里第一个可用的。");
          }
        }
      }

      // 4. 本地 Ollama（本地模式必查；对话模式下是退路，查不到只提示不算失败）
      const isFallback = mode === "chat";
      try {
        const r = await fetch(`${cfg.ollama}/api/tags`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: any = await r.json();
        const names: string[] = (data?.models ?? []).map((m: any) => String(m?.name ?? ""));
        const want = String(cfg.ollama_model ?? "").trim();
        const hit = names.includes(want) || names.includes(want + ":latest") || names.some((n) => n.startsWith(want + ":"));
        if (hit) lines.push(`[✓] 本地模型 ${want} 在 Ollama 里（共 ${names.length} 个模型）`);
        else if (isFallback) lines.push(`[!] 本地退路 ${want} 不在 Ollama 里，对话模型看不了图时没人接手。现有：${names.slice(0, 8).join("、") || "一个都没有"}`);
        else {
          ok = false;
          lines.push(`[×] 本地模型 ${want} 不在 Ollama 里。现有：${names.slice(0, 8).join("、") || "一个都没有"}`);
        }
      } catch (error: any) {
        if (isFallback) lines.push(`[!] 连不上 Ollama（${cfg.ollama}）：${error?.message ?? error}；只影响退路`);
        else {
          ok = false;
          lines.push(`[×] 连不上 Ollama（${cfg.ollama}）：${error?.message ?? error}`);
        }
      }

      // 5. 出图目录能不能建
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
      const warns = (await eyesRunning())
        ? [
            "eyes 插件也开着。它默认把本地 qwen3-vl:4b 视觉模型拉进显卡，和本插件同时用、显存又不够时，整机可能卡死（本机实测过）。留一个就够了，建议到插件管理里停用 eyes。",
          ]
        : [];
      res.end(renderPage(cfg, chatModels(ctx), warns));
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
