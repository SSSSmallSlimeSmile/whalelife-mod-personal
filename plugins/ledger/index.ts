/*! WhaleLife「账本」插件：把会话里记下的 request_usage 按价目表重算成参考金额。
 *
 * 为什么做成插件：它只需要读 memory/sessions 下的 jsonl，再把结果画出来，
 * 不需要在回合开始前插一手，所以不必动主干。
 *
 * 三条不变量：
 * 1. 只读。不写会话、不拦请求、不改任何用量记录。
 * 2. 金额是参考价，不是账单。算不出来就记「未定价」，绝不猜一个数。
 * 3. 缓存缺失、峰谷时段这类「只能给区间」的行，页面显示区间，不取上界。
 *
 * 页面直接引用宿主的 /ui/styles.css，所以它和管理页是同一套样式，
 * 不是照着画一份，宿主改配色这里跟着变。
 */
import type { Context } from "../../core/context.ts";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDays, collectHours } from "./usage.ts";
import { VERIFIED } from "./prices.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** plugins/ledger → 仓库根。 */
const ROOT = resolve(HERE, "../..");

const DEFAULTS = {
  enabled: true,
  /** 明细表默认看几天。 */
  days: 7,
  /** 额外统计 memory/usage-judge.jsonl（按难度挑模型的扩展才有）。 */
  include_judge_usage: false,
};

type Config = typeof DEFAULTS;

async function loadGlobal(): Promise<any> {
  for (const name of ["config/config.json", "config.json"]) {
    try {
      return JSON.parse((await readFile(join(ROOT, name), "utf8")).replace(/^\uFEFF/, ""));
    } catch {
      /* 试下一个 */
    }
  }
  return {};
}

const money = (n: number, cur = "USD") => `${cur === "CNY" ? "¥" : "$"}${n.toFixed(4)}`;
const usd = (pair: any) => Number(pair?.USD ?? 0);
const rangeText = (row: any) => usd(row.max) - usd(row.min) > 1e-9
  ? `${money(usd(row.min))}–${money(usd(row.max))}` : money(usd(row.max));

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try { saved = await ctx.config.read<Partial<Config>>("config.json"); } catch { saved = null; }
  const cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };
  if (!cfg.enabled) {
    ctx.logger.info("账本插件已停用（config.json 里 enabled=false）");
    return;
  }

  const snapshot = async (days: number) => {
    const global = { ...(await loadGlobal()), include_judge_usage: cfg.include_judge_usage };
    const [rows, hourly] = await Promise.all([
      collectDays(ROOT, global, days),
      collectHours(ROOT, global),
    ]);
    return { rows, hourly, config: { days, timezone: global?.timezone ?? null, verified: VERIFIED } };
  };

  ctx.web.page("/plugins/ledger/data", async (req, res) => {
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const days = Math.min(90, Math.max(1, Number(query.get("days")) || Number(cfg.days) || 7));
    const body = JSON.stringify(await snapshot(days));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  });

  ctx.web.page("/plugins/ledger/", async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(PAGE);
  }, { title: "账本", navigation: true });

  ctx.tools.register({
    name: "ledger_today",
    description: "查今天到目前为止各模型的 token 用量和参考金额。金额按价目表重算，不是账单。",
    danger: "safe",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const global = { ...(await loadGlobal()), include_judge_usage: cfg.include_judge_usage };
      const [rows, hourly] = await Promise.all([
        collectDays(ROOT, global, 1),
        collectHours(ROOT, global),
      ]);
      const today = hourly.day;
      const lines = rows.filter((r) => r.day === today).map((r) => {
        const cost = r.exact ? money(usd(r.max)) : rangeText(r);
        return `${r.model}（${r.provider}）${r.requests} 次，入 ${r.input}、出 ${r.output}，${cost}`;
      });
      const total = hourly.hours.reduce((sum, h) => sum + h.max.USD, 0);
      return { ok: true, result: lines.length
        ? `${today}\n${lines.join("\n")}\n合计参考 ${money(total, "USD")}（价目核验 ${VERIFIED}，不是账单）`
        : `${today} 还没有记录` };
    },
  });

  ctx.logger.info("账本插件已就绪", { root: ROOT, days: cfg.days });
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>账本</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
body{background:var(--bg)}
.wrap{max-width:1120px;margin:0 auto;padding:26px 22px 64px}
</style></head><body><div class="wrap">
<section class="panel">
<div class="panel-header"><h2>用量</h2><div class="pg-actions"><select id="days" aria-label="统计范围">
<option value="1">今天</option><option value="7" selected>最近 7 天</option><option value="30">最近 30 天</option>
</select><button id="refresh" class="btn small" type="button">重算</button></div></div>
<div class="panel-body">
<p class="pg-hint" style="margin:0 0 16px">按天、按 provider 与模型统计 token 用量，金额按当前价目重算，仅供参考，不是账单。只统计，不拦请求。</p>
<div id="body"><section class="panel empty">正在读取账本…</section></div>
</div></div></section>
<script>
var COLORS = ["#5b7cfa","#8b5cf6","#22c55e","#f59e0b","#ef4444","#06b6d4","#e879f9","#84cc16"];
function esc(s){return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){
  return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";});}
function money4(v){return Number(v || 0).toFixed(4);}
function amount(row){
  var out = [], cur, sign, low;
  var list = ["CNY", "USD"];
  for (var i = 0; i < list.length; i++) {
    cur = list[i];
    if (!(row.max[cur] > 0)) continue;
    sign = cur === "CNY" ? "\\u00a5" : "$";
    low = sign + money4(row.min[cur]);
    out.push(row.exact ? low : low + "\\u2013" + sign + money4(row.max[cur]));
  }
  return out.length ? out.join(" / ") : "无价";
}
function kilo(v){return Number(v || 0).toLocaleString("en-US");}
function short(v){
  var trim = function(s){return s.replace(/\\.0$/, "");};
  if (v >= 1e9) return trim((v / 1e9).toFixed(1)) + "B";
  if (v >= 1e6) return trim((v / 1e6).toFixed(1)) + "M";
  if (v >= 1e3) return trim((v / 1e3).toFixed(1)) + "k";
  return String(Math.round(v));
}
function nice(v){
  if (!(v > 0)) return 0.01;
  var step = Math.pow(10, Math.floor(Math.log10(v))), r = v / step;
  var k = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10;
  return k * step;
}
function byDay(rows){
  var map = {};
  rows.forEach(function(row){
    var it = map[row.day] || (map[row.day] = {day: row.day, input: 0, output: 0, requests: 0});
    it.input += row.input; it.output += row.output; it.requests += row.requests;
  });
  return Object.keys(map).sort().map(function(k){return map[k];});
}
function byModel(rows){
  var map = {};
  rows.forEach(function(row){
    var key = row.provider + " / " + row.model;
    var it = map[key] || (map[key] = {key: key, input: 0, output: 0, requests: 0});
    it.input += row.input; it.output += row.output; it.requests += row.requests;
  });
  var list = Object.keys(map).map(function(k){return map[k];});
  list.sort(function(a, b){return b.input - a.input;});
  return list.slice(0, 8);
}
function dayAxis(days){
  var pad = function(v){return String(v).padStart(2, "0");};
  var list = [], i, d;
  for (i = days - 1; i >= 0; i--) {
    d = new Date(); d.setDate(d.getDate() - i);
    list.push(d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()));
  }
  return list;
}
function dayChart(series, days){
  var map = {}, axis, raw, step, top, ticks, grid, dense, every, bars;
  series.forEach(function(it){map[it.day] = it;});
  axis = dayAxis(days).map(function(day){
    return map[day] || {day: day, input: 0, output: 0, requests: 0};
  });
  raw = Math.max.apply(null, axis.map(function(it){return it.input;}).concat([0]));
  step = nice(raw / 4); top = step * 4;
  ticks = [4,3,2,1,0].map(function(i){return short(step * i);});
  grid = [4,3,2,1].map(function(i){return '<i style="bottom:' + i * 25 + '%"></i>';}).join("");
  dense = axis.length > 14;
  every = dense ? Math.ceil(axis.length / 6) : 1;
  bars = axis.map(function(it, index){
    var height = it.input ? Math.max(1.5, it.input / top * 100) : 0;
    var flip = index > axis.length * 0.72 ? " flip" : "";
    var fill = height ? '<span class="hour-seg" style="height:' + height.toFixed(3) +
      '%;background:var(--accent)"></span>' : "";
    var tip = it.input
      ? '<div class="hour-tip' + flip + '"><strong>' + it.day + " \\u00b7 " + short(it.input) + "</strong>" +
        '<span class="hour-tip-row"><i style="background:var(--accent)"></i>输入<b>' + short(it.input) + "</b></span>" +
        '<span class="hour-tip-row"><i style="background:#8f88e8"></i>输出<b>' + short(it.output) + "</b></span>" +
        '<span class="hour-tip-row">调用<b>' + it.requests + " 次</b></span></div>"
      : '<div class="hour-tip' + flip + '"><strong>' + it.day +
        '</strong><span class="hour-tip-row empty">无记录</span></div>';
    var mark = (!dense || index % every === 0)
      ? '<em class="hour-mark">' + it.day.slice(5) + "</em>" : "";
    return '<div class="hour-bar' + (it.input ? "" : " day-zero") + '"><div class="hour-stack">' +
      fill + "</div>" + mark + tip + "</div>";
  }).join("");
  return '<div class="hour-chart"><div class="hour-yaxis">' +
    ticks.map(function(t){return "<span>" + t + "</span>";}).join("") +
    '</div><div class="hour-plot"><div class="hour-grid">' + grid +
    '</div><div class="hour-bars">' + bars + "</div></div></div>";
}
function ranking(models){
  var max = Math.max.apply(null, models.map(function(it){return it.input;}).concat([1]));
  return '<div class="usage-ranking">' + models.map(function(it){
    var width = Math.max(4, Math.round(it.input / max * 100));
    return '<div class="usage-rank"><span class="usage-rank-name" title="' + esc(it.key) + '">' + esc(it.key) +
      '</span><div class="usage-rank-track"><div class="usage-rank-fill" style="width:' + width +
      '%"></div></div><span class="usage-rank-value">' + kilo(it.requests) + " 次 \\u00b7 " +
      kilo(it.input) + "</span></div>";
  }).join("") + "</div>";
}
function hourlyChart(hourly){
  var rows = hourly && hourly.hours ? hourly.hours : [];
  if (!rows.length) return "";
  var models = [], h, k, i;
  for (i = 0; i < rows.length; i++) {
    k = rows[i].provider + " / " + rows[i].model;
    if (models.indexOf(k) < 0) models.push(k);
  }
  var colorOf = function(key){return COLORS[models.indexOf(key) % COLORS.length];};
  var sumOf = function(cur){
    return rows.reduce(function(s, r){return s + (r.max[cur] || 0);}, 0);
  };
  var currency = sumOf("CNY") > sumOf("USD") ? "CNY" : "USD";
  var other = currency === "CNY" ? "USD" : "CNY";
  var label = currency === "CNY" ? "\\u00a5" : "$";
  var cells = [];
  for (h = 0; h < 24; h++) {
    var inHour = rows.filter(function(r){return r.hour === h;});
    var segs = models.map(function(key){
      var own = inHour.filter(function(r){return r.provider + " / " + r.model === key;});
      return {
        key: key,
        value: own.reduce(function(s, r){return s + (r.max[currency] || 0);}, 0),
        low: own.reduce(function(s, r){return s + (r.min[currency] || 0);}, 0)
      };
    }).filter(function(s){return s.value > 0;});
    segs.sort(function(a, b){return b.value - a.value;});
    cells.push({
      hour: h,
      segments: segs,
      total: segs.reduce(function(s, x){return s + x.value;}, 0),
      low: segs.reduce(function(s, x){return s + x.low;}, 0)
    });
  }
  var raw = Math.max.apply(null, cells.map(function(c){return c.total;}).concat([0]));
  var step = nice(raw / 4), top = step * 4;
  var digits = top >= 1 ? 2 : top >= 0.1 ? 3 : 4;
  var moneyN = function(v){return label + v.toFixed(digits);};
  var range = function(low, high){
    return high - low > 1e-9 ? moneyN(low) + "\\u2013" + moneyN(high) : moneyN(high);
  };
  var clock = function(hour){return String(hour).padStart(2, "0") + ":00";};
  var ticks = [4,3,2,1,0].map(function(i){return moneyN(step * i);});
  var grid = [4,3,2,1].map(function(i){return '<i style="bottom:' + i * 25 + '%"></i>';}).join("");
  var bars = cells.map(function(cell){
    var flip = cell.hour >= 17 ? " flip" : "";
    var stack = cell.segments.map(function(seg){
      return '<span class="hour-seg" style="height:' + (seg.value / top * 100).toFixed(3) +
        "%;background:" + colorOf(seg.key) + '"></span>';
    }).join("");
    var tip = cell.total
      ? '<div class="hour-tip' + flip + '"><strong>' + clock(cell.hour) + " \\u00b7 " +
        range(cell.low, cell.total) + "</strong>" + cell.segments.map(function(seg){
          return '<span class="hour-tip-row"><i style="background:' + colorOf(seg.key) + '"></i>' +
            esc(seg.key) + "<b>" + range(seg.low, seg.value) + "</b></span>";
        }).join("") + "</div>"
      : '<div class="hour-tip' + flip + '"><strong>' + clock(cell.hour) +
        '</strong><span class="hour-tip-row empty">无记录</span></div>';
    return '<div class="hour-bar"><div class="hour-stack">' + stack + "</div>" +
      (cell.hour % 3 === 0 ? '<em class="hour-mark">' + clock(cell.hour) + "</em>" : "") +
      tip + "</div>";
  }).join("");
  var legend = models.map(function(key){
    return '<span class="legend-item"><i style="background:' + colorOf(key) + '"></i>' +
      esc(key) + "</span>";
  }).join("");
  var otherTotal = sumOf(other);
  var note = otherTotal
    ? "另有 " + (other === "CNY" ? "\\u00a5" : "$") + otherTotal.toFixed(4) + " 来自另一种币种的模型，未并入此图。"
    : "按当前价目重算，仅供参考，不是账单。柱高一律取上界；遇峰谷时段或用量不完整的记录，悬停给出的是区间。";
  return '<section class="panel" style="margin-top:22px"><div class="panel-header"><h2>今日每小时消费</h2>' +
    '<span class="badge">' + esc(hourly.day || "") + " \\u00b7 按模型堆叠</span></div>" +
    '<div class="panel-body"><div class="usage-legend">' + legend + "</div>" +
    '<div class="hour-chart"><div class="hour-yaxis">' +
    ticks.map(function(t){return "<span>" + t + "</span>";}).join("") +
    '</div><div class="hour-plot"><div class="hour-grid">' + grid +
    '</div><div class="hour-bars">' + bars + '</div></div></div><p class="hint"><span>' +
    esc(note) + "</span></p></div></section>";
}
function render(data, days){
  var rows = data.rows || [];
  var totals = {requests: 0, input: 0, output: 0, unpriced: 0, inexact: 0, exact: true,
    min: {CNY: 0, USD: 0}, max: {CNY: 0, USD: 0}};
  rows.forEach(function(row){
    totals.requests += row.requests;
    totals.input += row.input;
    totals.output += row.output;
    totals.unpriced += row.unpriced || 0;
    ["CNY", "USD"].forEach(function(cur){
      totals.min[cur] += row.min[cur]; totals.max[cur] += row.max[cur];
    });
    if (!row.exact) { totals.exact = false; totals.inexact += 1; }
  });
  var cards = [
    ["请求", kilo(totals.requests) + " 次", "这段时间落盘的模型调用"],
    ["输入 token", kilo(totals.input), "每轮都要重发的上下文都在这里"],
    ["输出 token", kilo(totals.output), "模型实际写出来的部分"],
    ["参考金额", amount(totals), totals.exact ? "按当前价目重算" : "含峰谷区间，只能给范围"]
  ].map(function(card){
    return '<div class="panel stat-card"><small>' + card[0] + '</small>' +
      '<div class="stat-value' + (card[0] === "请求" ? "" : " text") + '">' + esc(card[1]) + "</div>" +
      '<div class="stat-foot">' + esc(card[2]) + "</div></div>";
  }).join("");
  var table = rows.length
    ? '<div class="ledger-table" role="table"><div class="ledger-row ledger-head" role="row">' +
      "<span>日期</span><span>模型</span><span>次数</span><span>输入</span><span>输出</span>" +
      "<span>参考金额</span></div>" + rows.map(function(row){
        return '<div class="ledger-row" role="row"><span>' + esc(row.day) + "</span>" +
          '<span class="ledger-model" title="' + esc(row.provider + " / " + row.model) + '">' +
          esc(row.provider) + " / " + esc(row.model) + "</span><span>" + kilo(row.requests) +
          "</span><span>" + kilo(row.input) + "</span><span>" + kilo(row.output) +
          '</span><span class="ledger-money">' + esc(amount(row)) + "</span></div>";
      }).join("") + "</div>"
    : '<div class="panel empty">这段时间还没有用量记录。</div>';
  var series = byDay(rows), models = byModel(rows), hourly = hourlyChart(data.hourly);
  var charts = series.length
    ? '<section class="panel" style="margin-top:22px"><div class="panel-header"><h2>每日输入 token</h2>' +
      '<span class="badge">' + series.length + ' 天</span></div><div class="panel-body">' +
      dayChart(series, days) + '<p class="hint"><span>输入是每轮重发的上下文，钱基本花在这里；' +
      "输出 token 见下表。</span></p></div></section>" +
      (models.length
        ? '<section class="panel" style="margin-top:22px"><div class="panel-header"><h2>模型排名</h2>' +
          '<span class="badge">按输入 token</span></div><div class="panel-body">' + ranking(models) +
          "</div></section>"
        : "")
    : "";
  var budget = data.budget;
  var budgetText = budget
    ? "每日预算：" + (budget.tokens ? kilo(budget.tokens) + " token" : "未设 token 上限") +
      (budget.amount ? "，" + (budget.currency === "CNY" ? "\\u00a5" : "$") +
        money4(Number(budget.amount)) : "") +
      (budget.note ? "（" + esc(budget.note) + "）" : "") + "。只记录，不拦截。"
    : "还没有设每日预算。";
  var foot = (totals.unpriced ? "其中 " + totals.unpriced + " 次不在价目表里，未计价。" : "") +
    (totals.inexact ? "其中 " + totals.inexact + " 行用量不完整（峰谷时段或中转未上报缓存），金额只能给区间。" : "") +
    "输入是输出的 " + (totals.output ? Math.round(totals.input / totals.output) : "\\u2014") +
    " 倍，长上下文就是这个数撑起来的；缓存命中能省一部分，但 provider 不上报时这一列是空的。";
  return '<div class="stats-grid">' + cards + "</div>" + hourly + charts +
    '<section class="panel"><div class="panel-header"><h2>用量明细</h2><span class="badge">' +
    rows.length + " 行 \\u00b7 " + esc(data.config.timezone || "") + '</span></div>' +
    '<div class="panel-body">' + table + '<p class="hint"><span>' + esc(foot) +
    "</span></p></div></section>" +
    '<section class="panel panel-body" style="margin-top:22px"><h2>每日预算</h2><p>' +
    esc(budgetText) + '</p><p class="hint"><span>想在聊天里改，直接让助手调 budget_set 工具。</span></p></section>' +
    '<p class="hint" style="margin-top:16px"><span>价目核验 ' + esc(data.config.verified || "") +
    "，金额按当前价目重算，不是账单。</span></p>";
}
var box = document.getElementById("body");
function load(){
  var days = Number(document.getElementById("days").value) || 7;
  box.innerHTML = '<section class="panel empty">正在读取账本…</section>';
  return fetch("/plugins/ledger/data?days=" + days, {cache: "no-store"}).then(function(res){
    return res.json();
  }).then(function(data){
    box.innerHTML = render(data, days);
  }).catch(function(err){
    box.innerHTML = '<section class="panel empty">读不到账本：' + esc(err.message) + "</section>";
  });
}
document.getElementById("days").addEventListener("change", load);
document.getElementById("refresh").addEventListener("click", load);
load();
</script></body></html>`;
