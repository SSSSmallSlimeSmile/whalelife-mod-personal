/*! WhaleLife「生图」插件页面：看状态、启停 ComfyUI、改参数。
 *
 * 类名一律 pg- 前缀：宿主 styles.css 里有 .row / .field 这类通用选择器，
 * 撞上了会把标签挤到左边（插件配置页踩过一次）。
 */
const FIELDS = {
  python: {
    label: "Python 解释器",
    kind: "text",
    hint: "跑边车用哪个 Python。边车只用标准库，随便哪个都行；留空则找 WHALELIFE_COMFY_PYTHON，再退回 PATH 里的 python。",
  },
  base_url: {
    label: "ComfyUI 地址",
    kind: "text",
    hint: "默认 http://127.0.0.1:8188。局域网别的机器也能填，但要放行端口。",
  },
  comfy_root: {
    label: "ComfyUI 目录",
    kind: "text",
    hint: "便携版根目录。启动时按这里的 python_embeded\\python.exe 和 ComfyUI\\main.py 找。",
  },
  launch_args: {
    label: "启动参数",
    kind: "text",
    hint: "默认 --lowvram：把权重分块换进换出，8G 卡也能跑 SDXL，代价是慢一点。卡大可以改成 --highvram。",
  },
  timeout_seconds: {
    label: "出图超时（秒）",
    kind: "number",
    min: 30,
    max: 1800,
    hint: "一次出图最多等多久。SDXL 25 步在本机约 60 秒，大尺寸或高步数会更久。",
  },
  need_vram_mb: {
    label: "显存报警阈值（MiB）",
    kind: "number",
    min: 500,
    max: 40000,
    hint: "出图前查剩余显存，低于这个数就报警不硬跑。查不到显卡信息时不拦。",
  },
  vram_guard: {
    label: "出图前检查显存",
    kind: "boolean",
    hint: "关掉就一直尝试。显存真不够时可能整机卡死，不建议关。",
  },
  auto_start: {
    label: "WhaleLife 开启时自动拉起",
    kind: "boolean",
    hint: "改完要等下次 WhaleLife 启动才生效。现在想开就按下面的「启动服务」。",
  },
  stop_on_exit: {
    label: "关闭 WhaleLife 时一并关掉",
    kind: "boolean",
    hint: "只关本插件拉起的那个进程。你要是自己开的 ComfyUI，不会被关。",
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

/** 只留白名单字段，数字钳制，布尔转真布尔。 */
export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    const value = (input as any)[key];
    if (spec.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.max((spec as any).min, Math.min((spec as any).max, Math.round(n)));
    } else if (spec.kind === "boolean") {
      out[key] = value === true || value === "true" || value === "on" || value === 1;
    } else {
      out[key] = String(value ?? "").slice(0, 500);
    }
  }
  return out;
}

function field(key: FieldKey, cfg: any): string {
  const spec: any = FIELDS[key];
  const value = cfg?.[key];
  const name = esc(key);
  const label = esc(spec.label);
  const hint = spec.hint ? `<p class="pg-hint">${esc(spec.hint)}</p>` : "";
  let control: string;
  if (spec.kind === "boolean") {
    control = `<label class="pg-check"><input type="checkbox" name="${name}" value="1"${
      value ? " checked" : ""
    }><span>${label}</span></label>`;
    return `<div class="pg-field pg-wide">${control}${hint}</div>`;
  }
  if (spec.kind === "number") {
    control = `<input type="number" name="${name}" step="1" min="${spec.min}" max="${spec.max}" value="${esc(value)}">`;
  } else {
    control = `<input type="text" name="${name}" value="${esc(value)}">`;
  }
  return `<div class="pg-field"><label>${label}</label>${control}${hint}</div>`;
}

type PageState = {
  up: boolean;
  workflows: string[];
  health: { version?: string; free?: number; total?: number };
  vramFree: number | null;
};

export function renderPage(cfg: any, state: PageState): string {
  const health = state.health ?? {};
  const dots: string[] = [];
  dots.push(
    state.up
      ? `<span class="pg-dot pg-on"></span>ComfyUI 在跑${health.version ? " · v" + esc(health.version) : ""}`
      : `<span class="pg-dot pg-off"></span>ComfyUI 没在跑`,
  );
  if (state.up && health.total) {
    const used = (health.total ?? 0) - (health.free ?? 0);
    const pct = Math.max(0, Math.min(100, Math.round((used / (health.total || 1)) * 100)));
    dots.push(
      `<span class="pg-meter"><span style="width:${pct}%"></span></span>` +
        `<small>显存 ${used.toFixed(0)} / ${health.total.toFixed(0)} MiB（${pct}%）</small>`,
    );
  } else if (!state.up && state.vramFree !== null) {
    dots.push(`<small>显卡空闲 ${state.vramFree} MiB</small>`);
  }
  const wf = state.workflows.length
    ? state.workflows.map((n) => `<code>${esc(n)}</code>`).join(" ")
    : `<small>${state.up ? "工作流目录是空的" : "要连上才看得到"}</small>`;

  const rows: string[] = [];
  const keys = Object.keys(FIELDS) as FieldKey[];
  // 两列排：文本类窄，数字类窄，布尔各自独占一行
  for (const key of keys) rows.push(field(key, cfg));

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>生图</title><link rel="stylesheet" href="/ui/styles.css">
<style>
.pg-wrap{max-width:920px;margin:0 auto;padding:18px}
.pg-panel{background:var(--panel,#fff);border:1px solid var(--line,#e5e5e5);border-radius:12px;margin-bottom:16px}
.pg-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line,#e5e5e5)}
.pg-head h2{margin:0;font-size:15px;font-weight:700}
.pg-body{padding:16px 18px}
.pg-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
.pg-status small{color:#8a8a8a}
.pg-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.pg-on{background:#2fa84f}.pg-off{background:#c9c9c9}
.pg-meter{width:120px;height:6px;background:#eee;border-radius:3px;overflow:hidden;display:inline-block}
.pg-meter>span{display:block;height:100%;background:#8b7cf6}
.pg-form{display:grid;grid-template-columns:1fr 1fr;gap:20px 32px}
.pg-wide{grid-column:1 / -1}
.pg-field label{display:block;font-size:15px;font-weight:700;margin-bottom:6px}
.pg-field input[type=text],.pg-field input[type=number]{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d8d8d8;border-radius:7px;font-size:13px}
.pg-hint{margin:6px 0 0;font-size:12px;line-height:1.55;color:#8a8a8a}
.pg-check{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700}
.pg-check span{font-weight:700}
.pg-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.pg-btn{padding:8px 16px;border:1px solid #d8d8d8;background:#fff;border-radius:8px;cursor:pointer;font-size:13px}
.pg-btn:hover{border-color:#8b7cf6;color:#6b5ce0}
.pg-btn.pg-primary{background:#6b5ce0;border-color:#6b5ce0;color:#fff}
.pg-msg{margin-top:10px;font-size:13px;min-height:18px;color:#6b6b6b}
</style></head><body>
<div class="pg-wrap">
  <div class="pg-panel">
    <div class="pg-head"><h2>服务</h2><span style="flex:0 0 auto"></span></div>
    <div class="pg-body">
      <div class="pg-status">${dots.join("")}</div>
      <p class="pg-hint" style="margin-top:10px">可用工作流：${wf}</p>
      <div class="pg-actions" style="margin-top:12px">
        <button class="pg-btn pg-primary" id="start">启动服务</button>
        <button class="pg-btn" id="stop">停止服务</button>
        <button class="pg-btn" id="refresh">刷新状态</button>
      </div>
      <div class="pg-msg" id="msg"></div>
    </div>
  </div>
  <form class="pg-panel" id="f">
    <div class="pg-head"><h2>参数</h2><button class="pg-btn pg-primary" type="submit">保存</button></div>
    <div class="pg-body"><div class="pg-form">${rows.join("")}</div></div>
  </form>
  <div class="pg-panel">
    <div class="pg-head"><h2>手动画遮罩（局部重绘）</h2><span style="flex:0 0 auto"></span></div>
    <div class="pg-body">
      <p class="pg-hint" style="margin-top:0">复杂的边缘——贴着衣摆轮廓、要绕开手指——交给人用 Photoshop 画，比让模型按坐标猜准得多。规则很短：</p>
      <ul class="pg-hint" style="margin:8px 0 0;padding-left:20px;line-height:1.8">
        <li>尺寸和原图一模一样，不缩放、不裁切</li>
        <li>存 PNG，灰度或 RGB 都行</li>
        <li><b>白色</b> = 要重画的地方，<b>黑色</b> = 保留</li>
        <li>边缘画硬，别羽化；重绘时工具会自己往外扩几个像素</li>
        <li>存到 <code>plugins/comfy/out/</code>，把文件名告诉我</li>
      </ul>
      <p class="pg-hint">反过来，规则图形（一块矩形、腰间一条带子）直接报坐标更快：「x150–200, y800–850」，我按坐标画矩形遮罩。</p>
    </div>
  </div>
  <p class="pg-hint">出图走 <code>comfy_generate</code> 工具，也可以在页面上比赛着用。一次 SDXL 出图本机约一分钟，期间没有别的输出。</p>
</div>
<script>
const msg = document.getElementById("msg");
const show = (text) => { msg.textContent = text; };
const call = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return await r.json();
};
document.getElementById("start").onclick = async () => {
  show("启动中…");
  const r = await call("/plugins/comfy/service", { action: "start" }).catch((e) => ({ message: String(e) }));
  show(r.message || r.error || "完成");
};
document.getElementById("stop").onclick = async () => {
  show("停止中…");
  const r = await call("/plugins/comfy/service", { action: "stop" }).catch((e) => ({ message: String(e) }));
  show(r.message || r.error || "完成");
};
document.getElementById("refresh").onclick = () => location.reload();
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const data = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") data[el.name] = el.checked;
    else data[el.name] = el.value;
  }
  const r = await call("/plugins/comfy/save", data);
  show(r.ok ? "已保存：" + (r.saved || []).join("、") : "没存上：" + (r.error || ""));
};
</script>
</body></html>`;
}
