/*! 看屏插件的配置页：出表单、收表单、把能改的字段列清楚。
 *
 * 只做三件事：渲染、读请求体、把提交上来的值洗一遍。
 * 洗的逻辑必须在这边，因为页面是明文的，谁都改得了。
 */

/** 可编辑字段：类型、上下限、说明。没列在这里的字段一律拒收。 */
const FIELDS = {
  python: {
    kind: "text",
    label: "Python 解释器",
    hint: "要带 numpy 和 Pillow 的那个 python。留空则依次找环境变量 WHALELIFE_PEEK_PYTHON、PATH 里的 python。Windows 上 PATH 里的 python 常是应用商店的占位符，一跑就报「边车没跑成」，那时把完整路径填进来。",
  },
  seconds: {
    kind: "number", min: 2, max: 60,
    label: "默认抓多久（秒）",
    hint: "一次看屏默认抓几秒。画面不动的时段几乎不留帧，抓长一点并不费事；想让它在长视频里多抓几次变化，就调大。",
  },
  max_frames: {
    kind: "number", min: 1, max: 12,
    label: "一张图最多装几帧",
    hint: "画面变化多时挑几帧拼进同一张图。帧多了细节全，但识图更慢、更费 token；6 是常用值。",
  },
  max_width: {
    kind: "number", min: 400, max: 4096,
    label: "成品图最大宽度",
    hint: "拼好的那张图缩到多宽再送去识图。太宽视觉模型反而看不清细节，1600 一般够用。",
  },
  focus: {
    kind: "select",
    label: "截取范围",
    options: [
      { value: "auto", label: "自动挑区域（推荐）" },
      { value: "content", label: "只送内容区" },
      { value: "whole", label: "整屏不裁" },
    ],
    hint: "自动：先看前台窗口，把变化最集中的一块裁出来；窗口占满全屏、或画面到处在动时退回整屏。只送内容区：强制按变化区裁。整屏不裁：什么都看得到，但一半格子花在标题栏和任务栏上。",
  },
  tier_style: {
    kind: "select",
    label: "清晰度偏移",
    options: [
      { value: "native", label: "按变化快慢自动定" },
      { value: "up", label: "偏清晰（格子大、帧少）" },
      { value: "down", label: "偏省（格子小、帧多）" },
    ],
    hint: "画面变化慢时格子会自动放大变清晰，变化快时自动缩小以装下更多帧。这一项是整体往哪边偏一档。",
  },
  tier_lock: {
    kind: "number", min: 0, max: 3,
    label: "锁死清晰度档（0 = 不锁）",
    hint: "填 0 交给上一项自动决定。填 1 最清晰，但一张图最多只装 3 帧；填 3 最省，能装到 12 帧。想看清字就填 1，想看整体变化就填 3。",
  },
  text_layer: {
    kind: "boolean",
    label: "附上屏幕上的文字（慢）",
    hint: "额外提取窗口文字和 OCR 结果，识图更准，但每次要多等几秒。默认关。",
  },
  vision_mode: {
    kind: "select",
    label: "识图走哪条路",
    options: [
      { value: "chat", label: "用对话模型（推荐）" },
      { value: "ollama", label: "用本地 Ollama" },
    ],
    hint: "对话模型：把拼好的图交给会看图的那个对话模型，本机不用装视觉模型，也不用 Ollama 在跑。本地 Ollama：走本机的视觉模型，不花 API 的钱，但要求 Ollama 开着、模型也在。",
  },
  vision_model: {
    kind: "select",
    dynamic: "chat",
    dep: { key: "vision_mode", values: ["chat"] },
    label: "用哪个对话模型看图",
    hint: "默认跟随当前会话的模型：你现在跟哪个模型说话，就用哪个看图。也可以指定一个别的——比如聊天用便宜的、看图用认得清的。选中的模型不支持图片时，会自动退回下面那个本地模型再试一次。",
  },
  ollama_model: {
    kind: "text",
    label: "本地 Ollama 的模型名",
    hint: "例如 qwen3-vl:4b。只在「用本地 Ollama」时作数，也是对话模型看不了图时的退路。",
  },
  ollama: {
    kind: "text",
    label: "Ollama 地址",
    hint: "通常是 http://127.0.0.1:11434。只有 Ollama 装在别的机器上才需要改。",
  },
  vram_guard: {
    kind: "boolean",
    label: "本地识图前先看显存",
    hint: "开着的话，加载本地视觉模型之前先问一次还剩多少显存；不够就不加载，直接说明原因。8GB 以下的显卡建议一直开着。",
  },
  need_vram_mb: {
    kind: "number", min: 1000, max: 40000,
    label: "本地视觉模型要多少显存（MiB）",
    hint: "qwen3-vl:4b 大约要 4700-5200。换成更大的模型就往上调。",
  },
  vision_timeout_ms: {
    kind: "number", min: 5000, max: 600000,
    label: "识图超时（毫秒）",
    hint: "单次送图给视觉模型最多等多久。云端模型或显存小、模型大时要放宽。",
  },
  run_timeout_ms: {
    kind: "number", min: 10000, max: 600000,
    label: "整次抓屏超时（毫秒）",
    hint: "从开始抓到出图的总体上限。抓的秒数调长了就得跟着放大，否则会被中途打断。",
  },
} as const;

type FieldKey = keyof typeof FIELDS;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** 读 POST 请求体，限 64KB。 */
export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("提交的内容太大了");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("提交的内容不是合法 JSON");
  }
}

/** 只留下白名单里的字段，数字做钳制，布尔转真布尔。 */
export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    const value = (input as any)[key];
    if (spec.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.max(spec.min, Math.min(spec.max, Math.round(n)));
    } else if (spec.kind === "boolean") {
      out[key] = value === true || value === "true" || value === "on" || value === 1;
    } else if (spec.kind === "select") {
      const text = String(value ?? "").trim();
      // 动态下拉的选项来自运行时，这里只把长度挡住，真伪由插件在调用时再校验
      if ((spec as any).dynamic) {
        out[key] = text.slice(0, 200);
        continue;
      }
      const ok = (spec.options as readonly any[]).some((o) => (typeof o === "string" ? o : o.value) === text);
      if (ok) out[key] = text;
    } else {
      out[key] = String(value ?? "").slice(0, 500);
    }
  }
  return out;
}

type ChatModelOption = { id: string; name: string; model: string };

function field(key: FieldKey, cfg: any, chatModels: ChatModelOption[]): string {
  const spec: any = FIELDS[key];
  const value = cfg?.[key];
  const name = esc(key);
  const label = esc(spec.label);
  const hint = spec.hint ? `<p class="pg-hint">${esc(spec.hint)}</p>` : "";
  let control: string;
  if (spec.kind === "boolean") {
    control = `<label class="pg-row pg-check"><input type="checkbox" name="${name}"${value ? " checked" : ""}><span class="pg-label">${label}</span></label>`;
  } else if (spec.kind === "select") {
    let options: Array<{ value: string; label: string }> = spec.options as any;
    if (spec.dynamic === "chat") {
      options = [{ value: "", label: "跟随当前会话模型" }].concat(
        chatModels.map((m) => ({ value: m.id, label: `${m.name}（${m.model}）` })),
      );
      const want = String(value ?? "").trim();
      if (want && !chatModels.some((m) => m.id === want)) {
        options.push({ value: want, label: `${want}（当前配置里没有这个名字）` });
      }
    }
    const opts = options
      .map((o) => {
        const selected = String(value ?? "") === o.value;
        return `<option value="${esc(o.value)}"${selected ? " selected" : ""}>${esc(o.label)}</option>`;
      })
      .join("");
    control = `<label class="pg-row"><span class="pg-label">${label}</span><select name="${name}">${opts}</select></label>`;
  } else if (spec.kind === "number") {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="number" name="${name}" value="${esc(value)}" min="${spec.min}" max="${spec.max}" step="${spec.step ?? 1}"></label>`;
  } else {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="text" name="${name}" value="${esc(value)}"></label>`;
  }
  const dep = (spec as any).dep as { key: string; values: string[] } | undefined;
  const depAttr = dep ? ` data-dep="${esc(dep.key)}" data-dep-values="${esc(dep.values.join(","))}"` : "";
  return `<div class="pg-item"${depAttr}>${control}${hint}</div>`;
}

/** 渲染配置页：结构和配色都走 /ui/styles.css，跟管理页同一套。
 * chatModels 是「用哪个对话模型看图」下拉的选项，由 index.ts 从宿主那边取来传进来。
 */
export function renderPage(cfg: any, chatModels: ChatModelOption[] = [], warnings: string[] = []): string {
  const warnBlock = warnings.length
    ? `<section class="panel" style="border-color:rgba(220,38,38,.45)"><div class="panel-header"><h2 style="color:#b91c1c">注意</h2></div><div class="panel-body">${warnings
        .map((w) => `<p class="pg-hint" style="margin:0 0 8px;color:#b91c1c">${esc(w)}</p>`)
        .join("")}</div></section>\n`
    : "";
  const items = (Object.keys(FIELDS) as FieldKey[]).map((k) => field(k, cfg, chatModels));
  const editable = items
    .reduce<string[]>((acc, cur, i) => {
      if (i % 2 === 0) acc.push(`<div class="pg-pair">${cur}`);
      else acc[acc.length - 1] += `${cur}</div>`;
      return acc;
    }, [])
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>看屏 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=number],.panel-body .pg-row select{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus,.panel-body .pg-row select:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px;padding-top:2px}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair:last-child{margin-bottom:0}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-item.pg-off{opacity:.45}
.panel-body .pg-item.pg-off .pg-hint{opacity:.8}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.panel-body .pg-ro{display:grid;grid-template-columns:150px 1fr;gap:16px;margin:14px 0;font-size:13px;align-items:baseline}
.panel-body .pg-ro b{font-weight:600;color:#797e8c}
.panel-body .pg-ro code{background:rgba(127,127,127,.12);padding:2px 6px;border-radius:5px;word-break:break-all;font-size:12px}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
#msg{font-size:13px;color:#059669;white-space:pre-line}
#msg.err{color:#dc2626}
.pg-result{margin:22px 0 0;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
.pg-result.wait{background:rgba(124,92,255,.10);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-result.ok{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-result.err{background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.35);color:#b91c1c}
#msg{display:none}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
</style></head><body>
<form id="f">
${warnBlock}<section class="panel"><div class="panel-header"><h2>可编辑</h2><div class="pg-actions"><button class="btn" type="button" id="test">测试配置</button><button class="btn primary" type="submit" form="f" id="ok">保存</button><span id="msg"></span></div></div><div class="panel-body">
${editable}
<div id="result" class="pg-result" hidden></div>
</div></section>
<section class="panel"><div class="panel-header"><h2>只读</h2><span class="badge">改不了</span></div><div class="panel-body">
<div class="pg-ro"><b>边车脚本</b><code>${esc(cfg?.script ?? "")}</code></div>
<div class="pg-ro"><b>出图目录</b><code>${esc(cfg?.shot_dir ?? "")}</code></div>
<p class="pg-hint" style="margin-left:0">这两项由宿主按插件目录算，写死容易弄坏，不在表单里。</p>
</div></section>
</form>
<script type="module">
const form = document.getElementById("f");
const msg = document.getElementById("msg");
const ok = document.getElementById("ok");
const depBoxes = [...form.querySelectorAll("[data-dep]")];
const syncDeps = () => {
  for (const box of depBoxes) {
    const src = form.elements[box.getAttribute("data-dep")];
    const vals = (box.getAttribute("data-dep-values") || "").split(",");
    const on = src ? vals.includes(src.value) : true;
    for (const el of box.querySelectorAll("input,select,textarea")) el.disabled = !on;
    box.classList.toggle("pg-off", !on);
  }
};
form.addEventListener("change", syncDeps);
syncDeps();
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  ok.disabled = true; msg.className = ""; msg.textContent = "保存中…";
  try {
    const res = await fetch("/plugins/peek/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    msg.textContent = "已保存，下次调用生效";
  } catch (error) {
    msg.className = "err";
    msg.textContent = "没存上：" + (error?.message || error);
  } finally { ok.disabled = false; }
});
const result = document.getElementById("result");
const show = (kind, text) => {
  result.hidden = false;
  result.className = "pg-result " + kind;
  result.textContent = text;
};
document.getElementById("test").addEventListener("click", async () => {
  const btn = document.getElementById("test");
  btn.disabled = true;
  show("wait", "测试中…请稍等");
  try {
    const res = await fetch("/plugins/peek/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || ("HTTP " + res.status));
    show("ok", Array.isArray(body.lines) ? body.lines.join(String.fromCharCode(10)) : (body.detail || body.text || "正常"));
  } catch (error) {
    show("err", "测试失败：" + (error?.message || error));
  } finally { btn.disabled = false; }
});
</script></body></html>`;
}
