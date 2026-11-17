/*! WhaleLife「嘴巴」插件配置页：一页，几个字段，保存和试念。 */

export async function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: any) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = input && typeof input === "object" ? input : {};
  if ("enabled" in src) {
    out.enabled = src.enabled === true || src.enabled === "on" || src.enabled === "true";
  }
  if ("url" in src) {
    const value = String(src.url ?? "").trim();
    if (value) out.url = value.replace(/\/+$/, "");
  }
  if ("ref_audio" in src) out.ref_audio = String(src.ref_audio ?? "").trim();
  if ("prompt_text" in src) out.prompt_text = String(src.prompt_text ?? "").trim();
  if ("speed" in src) {
    const n = Number(src.speed);
    if (Number.isFinite(n)) out.speed = Math.min(2, Math.max(0.5, Math.round(n * 10) / 10));
  }
  if ("engine" in src) {
    const value = String(src.engine ?? "").trim();
    if (value === "local" || value === "deepseek") out.engine = value;
  }
  if ("cloud_url" in src) {
    const value = String(src.cloud_url ?? "").trim();
    if (value) out.cloud_url = value.replace(/\/+$/, "");
  }
  if ("cloud_key" in src) out.cloud_key = String(src.cloud_key ?? "").trim();
  if ("cloud_voice" in src) {
    const value = String(src.cloud_voice ?? "").trim();
    if (/^[a-z0-9_.-]{2,32}$/i.test(value)) out.cloud_voice = value;
  }
  if ("auto_scope" in src) {
    const value = String(src.auto_scope ?? "").trim().toLowerCase();
    if (value === "f9" || value === "all") out.auto_scope = value;
  }
  if ("max_chars" in src) {
    const n = Number(src.max_chars);
    if (Number.isFinite(n)) out.max_chars = Math.min(200, Math.max(40, Math.round(n)));
  }
  return out;
}

const VOICE_NAMES: Record<string, string> = {
  stella: "stella　海星，女声",
  tide: "tide　暗潮，男声",
};

const STYLE = `
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row select,.panel-body .pg-row input[type=password],.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=number]{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus,.panel-body .pg-row select:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-row input:disabled,.panel-body .pg-row select:disabled{opacity:.55;cursor:not-allowed}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.panel-body .pg-hint .btn{margin-left:8px;padding:3px 10px;font-size:12px}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.pg-result{margin:22px 0 0;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
.pg-result.wait{background:rgba(124,92,255,.10);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-result.ok{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-result.err{background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.35);color:#b91c1c}
.pg-tip{margin:0 0 26px;padding:14px 16px;border-radius:10px;font-size:13px;line-height:1.75;background:rgba(124,92,255,.08);border:1px solid rgba(124,92,255,.25);color:#6d4aff}
.pg-sub{margin:0 0 14px;font-size:12px;font-weight:700;color:#797e8c;letter-spacing:.06em}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
`;

function voiceOptions(current: any): string {
  const now = String(current ?? "stella").trim() || "stella";
  const list = ["stella", "tide"];
  if (!list.includes(now)) list.push(now);
  return list
    .map((one) => `<option value="${one}"${one === now ? " selected" : ""}>${VOICE_NAMES[one] ?? one}</option>`)
    .join("");
}

export function renderPage(cfg: any): string {
  const c = cfg ?? {};
  const esc = (value: any) =>
    String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const checked = c.enabled === true ? " checked" : "";
  const cloud = c.engine === "deepseek";
  const scopeAll = c.auto_scope === "all";
  const dis = cloud ? "" : " disabled";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嘴巴 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>${STYLE}</style></head><body>
<main class="page">
<section class="panel">
<div class="panel-header"><h2>合成与播放</h2><div class="pg-actions"><button class="btn primary" type="button" id="save">保存</button></div></div>
<div class="panel-body">
<div class="pg-tip">念之前会自动去掉：代码块、表格、链接、Windows 路径（换成「（略）」）、图片标记。<br>长回复按句切成多段，一段念完再念下一段。</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="enabled"${checked}><label class="pg-label" for="enabled">允许念出来（总开关）</label></div><p class="pg-hint">关掉就完全不出声，点聊天页的「念」按钮也不响。网页里聊天会自动念；按 F9 说的话由「耳朵」插件交过来念，不会念两遍。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="engine">合成引擎</label><select id="engine"><option value="local"${cloud ? "" : " selected"}>本地 GPT-SoVITS（自己的音色）</option><option value="deepseek"${cloud ? " selected" : ""}>DeepSeek 云端（stella / tide）</option></select><p class="pg-hint">本地那条用你训的音色；云端不用等本机服务，但只有两种固定声音，也不能调语速。</p></div></div>
</div>

    <div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="auto_scope">自动念 · 什么时候出声</label><select id="auto_scope"><option value="f9"${scopeAll ? "" : " selected"}>只有按 F9 说话才念</option><option value="all"${scopeAll ? " selected" : ""}>每一句回复都念（网页打字也念）</option></select><p class="pg-hint">同一个回复只念一次：按 F9 说的由「耳朵」交过来念，网页里打的由这里自己念。聊天页那个小喇叭随时能手动念，不算自动。</p></div></div>
</div>

<p class="pg-sub">云端专用 · 只在选了云端时可填</p>
<div class="pg-pair" id="cloudrow">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="cloud_key">云端 API Key</label><input type="password" id="cloud_key" value="${esc(c.cloud_key)}" placeholder="留空就用主配置里 DeepSeek 那把"${dis}><p class="pg-hint">留空会自动读主配置里 id 含 deepseek 的 provider。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="cloud_voice">云端音色</label><select id="cloud_voice"${dis}>${voiceOptions(c.cloud_voice)}</select><p class="pg-hint">云端没给列表接口，点这里让它自己报一遍合法音色<button class="btn" type="button" id="loadvoices">读取云端音色</button></p></div></div>
</div>

<p class="pg-sub">本地 GPT-SoVITS</p>
<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="url">GPT-SoVITS 地址</label><input type="text" id="url" value="${esc(c.url)}"><p class="pg-hint">默认 http://127.0.0.1:9880，端口要跟 voice 插件里的一致。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="speed">语速</label><input type="number" id="speed" step="0.1" min="0.5" max="2" value="${esc(c.speed)}"><p class="pg-hint">0.5 到 2.0，默认 1.2。云端不支持调语速。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="ref_audio">参考音频</label><input type="text" id="ref_audio" value="${esc(c.ref_audio)}"><p class="pg-hint">念的时候照着这个音色。留空则不念。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="prompt_text">参考音频对应文本</label><input type="text" id="prompt_text" value="${esc(c.prompt_text)}"><p class="pg-hint">要跟上面的音频逐字对应，写错了音色会飘。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="max_chars">每段最多几个字</label><input type="number" id="max_chars" step="10" min="40" max="200" value="${esc(c.max_chars)}"><p class="pg-hint">太长容易读出怪音，一般 110 就够。</p></div></div>
</div>

<div class="pg-actions" style="margin-left:0"><button class="btn" type="button" id="try">念一句试试</button></div>
<div class="pg-result" id="out" hidden></div>
</div>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const NAMES = { stella: "stella　海星，女声", tide: "tide　暗潮，男声" };
function show(kind, text) {
  const box = $("out");
  box.hidden = false;
  box.className = "pg-result " + kind;
  box.textContent = text;
}
function cloudSync() {
  const isCloud = $("engine").value === "deepseek";
  $("cloud_key").disabled = !isCloud;
  $("cloud_voice").disabled = !isCloud;
  $("loadvoices").disabled = !isCloud;
  $("cloudrow").style.opacity = isCloud ? "1" : "0.45";
}
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || value.reason || ("HTTP " + response.status));
  return value;
}
$("engine").onchange = cloudSync;
cloudSync();
$("loadvoices").onclick = async () => {
  const select = $("cloud_voice");
  const keep = select.value;
  show("wait", "正在问云端要音色…");
  try {
    const r = await post("/plugins/mouth/voices", {});
    const list = Array.isArray(r.voices) ? r.voices : [];
    if (!list.length) throw new Error("云端没给出音色");
    select.innerHTML = list.map((v) => '<option value="' + v + '">' + (NAMES[v] || v) + '</option>').join("");
    select.value = list.indexOf(keep) >= 0 ? keep : list[0];
    show("ok", "云端报了 " + list.length + " 个音色：" + list.join("、") + (r.source === "cloud" ? "（从云端读到的）" : "（默认兜底）") + "。记得点保存。");
  } catch (error) {
    show("err", "没读到：" + (error && error.message ? error.message : error));
  }
};
$("save").onclick = async () => {
  show("wait", "保存中…");
  const body = {
    enabled: $("enabled").checked,
    url: $("url").value,
    ref_audio: $("ref_audio").value,
    prompt_text: $("prompt_text").value,
    speed: $("speed").value,
    max_chars: $("max_chars").value,
    auto_scope: $("auto_scope").value,
    engine: $("engine").value,
    cloud_key: $("cloud_key").value,
    cloud_voice: $("cloud_voice").value,
  };
  try {
    await post("/plugins/mouth/save", body);
    show("ok", "已保存。改动下一次念就生效，不用重启。");
  } catch (error) {
    show("err", "保存失败：" + (error && error.message ? error.message : error));
  }
};
$("try").onclick = async () => {
  show("wait", "正在合成…第一次可能要等几秒");
  try {
    const r = await post("/plugins/mouth/test", {});
    show("ok", r.text || "念完了。");
  } catch (error) {
    show("err", "没念成：" + (error && error.message ? error.message : error));
  }
};
</script>
</body></html>`;
}
