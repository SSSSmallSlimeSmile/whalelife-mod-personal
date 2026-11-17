/*! WhaleLife「嘴巴」插件：把一段文字念出来（GPT-SoVITS）。
 *
 * 只做一件事：POST /plugins/mouth/say { text } -> 过滤 -> 分段 -> 合成 -> 播放。
 * 聊天气泡旁的「念」按钮调的就是这个。不经过 speak 工具，避开了它的 ask 审批。
 */
import type { Context } from "../../core/context.ts";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";
import { probeVoices } from "./voices.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  auto_scope: "f9",
  url: "http://127.0.0.1:9880",
  ref_audio: "",
  prompt_text: "或许我也曾向往过这种力量，但那更像是一种讽刺。",
  text_lang: "zh",
  prompt_lang: "zh",
  speed: 1.2,
  max_chars: 110,
  timeout_ms: 120_000,
  out_dir: join(HERE, "data", "out"),
  engine: "local",
  cloud_url: "https://api.deepseek.com/v1/tools/tts",
  cloud_key: "",
  cloud_voice: "stella",
  cloud_format: "wav",
  cloud_timeout_ms: 60_000,
};

/** 读主配置里 DeepSeek 的 key，用户没单独填时用它。 */
/** 支持 ${ENV:NAME} 形式的引用，凭据本身不必写进任何配置文件 */
function expand(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const hit = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  return hit ? String(process.env[hit[1]] ?? "").trim() : raw;
}
function mainConfigKey(): string {
  try {
    const file = join(HERE, "..", "..", "config", "config.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw?.providers) ? raw.providers : [];
    const found = list.find((one: any) => String(one?.id ?? "").includes("deepseek"));
    return expand(found?.api_key);
  } catch {
    return "";
  }
}

/** 去掉念出来会变成噪音的东西。 */
export function forSpeech(input: string): string {
  let s = String(input ?? "");
  s = s.replace(/```[\s\S]*?```/g, "。代码略。");
  s = s.replace(/`[^`]*`/g, "");
  s = s.replace(/\[\[[a-z]+:[^\]]*\]\]/gi, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/[^\s)）]+/g, "");
  const lines: string[] = [];
  let inTable = false;
  for (const line of s.split(/\r?\n/)) {
    let t = line.trim();
    if (t.startsWith("|")) {
      if (!inTable) {
        lines.push("表格略");
        inTable = true;
      }
      continue;
    }
    inTable = false;
    if (!t) continue;
    if (/^[-:|\s]{3,}$/.test(t)) continue;
    t = t.replace(/^#{1,6}\s*/, "");
    t = t.replace(/^[-*+]\s+/, "");
    lines.push(t);
  }
  s = lines.join("，");
  s = s.replace(/[A-Za-z]:\\[^\s，。；、）)]*/g, "（略）");
  s = s.replace(/（略）([，,、\s]*（略）)+/g, "（略）");
  s = s.replace(/\s*（略）\s*/g, "（略）");
  s = s.replace(/\*\*|__|~~|\*/g, "");
  s = s.replace(/[，,]{2,}/g, "，");
  s = s.replace(/，\s*，/g, "，");
  s = s.replace(/([。！？；])，/g, "$1");
  s = s.replace(/，([。！？；])/g, "$1");
  s = s.replace(/\s+([，。！？；])/g, "$1");
  s = s.replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

/** 按句切，每段不超过 max 字，切不到就硬截，不丢字。 */
export function splitForSpeech(text: string, max: number): string[] {
  const limit = Math.max(20, max);
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    for (const ch of ["。", "！", "？", "；", "，", "、", " "]) {
      const index = rest.lastIndexOf(ch, limit);
      if (index > cut) cut = index;
    }
    if (cut < limit * 0.4) cut = limit - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter((part) => part.length > 0);
}

/** 云端是流式返回，RIFF 和 data 的长度都是 0xFFFFFFFF 占位，SoundPlayer 会拒播，得重算。 */
export function fixWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.slice(0, 4).toString("ascii") !== "RIFF") return buf;
  const dataAt = buf.indexOf(Buffer.from("data", "ascii"), 12);
  if (dataAt < 0) return buf;
  const copy = Buffer.from(buf);
  if (copy.readUInt32LE(4) === 0xffffffff) copy.writeUInt32LE(copy.length - 8, 4);
  if (copy.readUInt32LE(dataAt + 4) === 0xffffffff) copy.writeUInt32LE(copy.length - dataAt - 8, dataAt + 4);
  return copy;
}

function replyJson(res: any, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function playFile(file: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`],
      { windowsHide: true, timeout: 180_000 },
      () => resolve(),
    );
  });
}

export async function apply(ctx: Context) {
  let cfg: any = { ...DEFAULTS };
  let busy = false;
  const queue: string[] = [];

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const next = queue.shift() as string;
        try {
          await speak(next);
        } catch (error: any) {
          ctx.logger?.warn?.(`嘴巴自动念失败：${error?.message ?? error}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  function enqueue(text: string) {
    if (queue.length >= 2) queue.shift();
    queue.push(text);
    void pump();
  }

  async function reload() {
    const saved = await ctx.config.read<any>("config.json").catch(() => null);
    cfg = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
    return cfg;
  }

  async function synthCloud(text: string) {
    const key = expand(cfg.cloud_key) || mainConfigKey();
    if (!key) throw new Error("没配 DeepSeek 的 key，主配置里也没找到 deepseek 的 provider");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(cfg.cloud_timeout_ms) || 60_000);
    try {
      const res = await fetch(String(cfg.cloud_url || "https://api.deepseek.com/v1/tools/tts"), {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice_id: String(cfg.cloud_voice || "stella"),
          format: String(cfg.cloud_format || "wav"),
          filter_markdown: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`云端合成失败 HTTP ${res.status}：${detail.slice(0, 160)}`);
      }
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length < 1000) throw new Error("云端返回的音频太小，可能合成失败");
      return fixWavHeader(raw);
    } catch (error: any) {
      if (controller.signal.aborted) throw new Error("云端合成超时");
      if (typeof error?.message === "string" && error.message.startsWith("云端")) throw error;
      throw new Error(`连不上云端合成（${cfg.cloud_url}）：${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function synth(text: string) {
    if (String(cfg.engine || "local") === "deepseek") return synthCloud(text);
    const query = new URLSearchParams({
      text,
      text_lang: cfg.text_lang,
      ref_audio_path: cfg.ref_audio,
      prompt_lang: cfg.prompt_lang,
      prompt_text: cfg.prompt_text,
      text_split_method: "cut5",
      media_type: "wav",
      streaming_mode: "false",
      speed_factor: String(cfg.speed),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(cfg.timeout_ms) || 120_000);
    try {
      const res = await fetch(`${cfg.url}/tts?${query.toString()}`, { signal: controller.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`语音合成失败 HTTP ${res.status}：${detail.slice(0, 120)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("返回的音频太小，可能合成失败");
      return buf;
    } catch (error: any) {
      if (controller.signal.aborted) throw new Error("语音合成超时");
      if (typeof error?.message === "string" && error.message.startsWith("语音合成失败")) throw error;
      if (typeof error?.message === "string" && error.message.includes("音频太小")) throw error;
      throw new Error(`连不上 GPT-SoVITS（${cfg.url}）：${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function speak(rawText: string) {
    await reload();
    const engine = String(cfg.engine || "local");
    if (engine !== "deepseek" && !cfg.ref_audio) throw new Error("没配参考音频，念不了");
    const clean = forSpeech(rawText);
    if (!clean) throw new Error("这段话过滤后没什么可念的");
    const meat = clean.replace(/代码略|表格略/g, "").replace(/[，。！？；、\s]/g, "");
    if (meat.length < 6) throw new Error("这段只有代码和表格，没什么可念的");
    const parts = splitForSpeech(clean, Number(cfg.max_chars) || 110);
    await mkdir(cfg.out_dir, { recursive: true });
    const started = Date.now();
    for (const part of parts) {
      const buf = await synth(part);
      const file = join(cfg.out_dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
      await writeFile(file, buf);
      await playFile(file);
    }
    return {
      ok: true,
      segments: parts.length,
      chars: clean.length,
      ms: Date.now() - started,
      preview: clean.slice(0, 60),
    };
  }

  ctx.web.page(
    "/plugins/mouth/",
    async (_req: any, res: any) => {
      await reload();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg));
    },
    { title: "嘴巴", navigation: true },
  );

  ctx.web.api("/plugins/mouth/say", async (req: any, res: any) => {
    try {
      const body = await readBody(req);
      const text = String(body?.text ?? "").trim();
      if (!text) return replyJson(res, 400, { ok: false, error: "没有要念的文字" });
      if (busy || queue.length) return replyJson(res, 409, { ok: false, error: "上一段还在念，等它念完" });
      busy = true;
      try {
        const r = await speak(text);
        return replyJson(res, 200, r);
      } finally {
        busy = false;
      }
    } catch (error: any) {
      busy = false;
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/mouth/test", async (_req: any, res: any) => {
    try {
      if (busy || queue.length) return replyJson(res, 409, { ok: false, error: "上一段还在念，等它念完" });
      busy = true;
      try {
        const r = await speak("嘴巴通了，我是勘。这句话是用来试音色的。");
        return replyJson(res, 200, { ...r, text: `念完了：${r.segments} 段，${r.chars} 字，用时 ${(r.ms / 1000).toFixed(1)} 秒。` });
      } finally {
        busy = false;
      }
    } catch (error: any) {
      busy = false;
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/mouth/save", async (req: any, res: any) => {
    try {
      const patch = sanitize(await readBody(req));
      if (!Object.keys(patch).length) throw new Error("没有可保存的字段");
      const merged = { ...(await ctx.config.read<any>("config.json").catch(() => null)), ...patch };
      await ctx.config.save("config.json", merged);
      await reload();
      return replyJson(res, 200, { ok: true, config: cfg });
    } catch (error: any) {
      return replyJson(res, 400, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/mouth/voices", async (_req: any, res: any) => {
    try {
      await reload();
      const found = await probeVoices(cfg, mainConfigKey());
      return replyJson(res, 200, { ok: true, ...found });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 给耳朵插件调用的入口：耳朵说完话拿到回复，交到这里念出来。
  // "F9 说完自动念"这件事归耳朵，念的实现归嘴巴，两个插件各管一段。
  ctx.tools.register({
    name: "mouth_say",
    description: "把一段文字念出来：自动去掉代码块、表格、图片标记、链接和文件路径，长文按句子分段播放。由耳朵插件在拿到回复后调用。",
    schema: {
      type: "object",
      properties: { text: { type: "string", description: "要念的内容" } },
      required: ["text"],
    },
    danger: "safe",
    run: async (args: any) => {
      await reload();
      const text = String(args?.text ?? "").trim();
      if (!text) return "没做：没有文本。";
      if (!cfg.enabled) return "嘴巴的「念出来」是关着的，没出声。";
      enqueue(text);
      return "已交给嘴巴念。";
    },
  });


  // 网页里打字也念。F9 那几轮由耳朵调 mouth_say，这里跳过，免得念两遍。
  ctx.on("channel/reply", async (ev: any) => {
    try {
      if (ev?.role !== "assistant") return;
      if (ev?.origin?.platform === "ear") return;
      await reload();
      if (!cfg.enabled) return;
      // 只念 F9：网页里打的字不出声（F9 那几轮由耳朵调 mouth_say 念）
      if (String(cfg.auto_scope || "f9") !== "all") return;
      const text = String(ev?.text ?? "").trim();
      if (!text) return;
      enqueue(text);
    } catch (error: any) {
      ctx.logger?.warn?.(`嘴巴：这一句没念成，${error?.message ?? String(error)}`);
    }
  });

  await reload();
  ctx.logger?.info?.(
    `嘴巴就绪（引擎 ${cfg.engine === "deepseek" ? "云端 " + cfg.cloud_voice : "本地 " + cfg.url}）`,
  );
}
