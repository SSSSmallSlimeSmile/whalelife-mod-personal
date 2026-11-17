# WhaleLife 插件（成品）

自己写的、跑通过、可以直接给群友用的 WhaleLife 插件。

**不是 WhaleLife 官方项目，与原作者无关。** 这些是个人写的扩展插件，不改主干代码，放进 `plugins/` 目录重启即可加载。

## 先说清楚：验证范围

下面这些插件和改动，**只在本人那台 Windows 电脑上跑过**。没有在手机上跑过，也没有在第二台电脑上跑过。

具体到每个插件，哪些验过、哪些没验过，写在各自的「状态」里。看到「可用」，意思是"在我这台机器上能用"，不是"在哪都能用"。装到别的机器上遇到问题，属于预期之内，不是谎报。

## 目录

| 插件 | 版本 | 做什么 | 状态 |
|---|---|---|---|
| `ledger` | 0.1.0 | 用量账本。扫会话记录里已有的 `request_usage`，页面在「插件 → 账本」，另有只读工具 `ledger_today` | 可用 |
| `peek` | 0.1.0 | 看屏取帧。抓一段屏幕，只留画面真正变化的那几帧，拼成一张图交给视觉模型 | 可用 |
| `mouth` | 0.1.0 | 把一段文字念出来。本地 GPT-SoVITS 或 DeepSeek 云端 TTS 二选一 | 可用（云端模式依赖 key，本地模式依赖本机模型） |

## 安装

把插件目录整个复制到 WhaleLife 的 `plugins/` 下，重启。

```
plugins/
├── ledger/
├── peek/
└── mouth/
```

三个插件互不依赖，可以只装其中一个。

---

## ledger 用量账本

不需要额外依赖，不需要配置。数据来自 `episodes/*.jsonl` 里已经存在的 `request_usage`，只读，不写任何东西。

价格表在 `prices.ts`，按 2026-11-16 的价目核过。**金额是参考值，不是账单**——按价目重算，和供应商实际扣费可能不同。

用量不完整的记录（峰谷时段、中转没上报缓存）只给区间，不取上界。这是踩过的坑：取上界会把某小时的金额放大三倍以上。

没验过的：多台机器同时读写同一份记录、特大型历史库（几十万条以上）的页面加载速度。

## peek 看屏取帧

**改自 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)。** 原始思路是"按画面变化取帧，不是定时截屏"。相对上游，这一版加了这些：

- 按前台窗口挑区域（`focus`），窗口占屏 8% 以下当噪点整屏抓，超过 92% 整屏抓
- `max_width` 参数
- 配置页，改配置不用重启
- 边车脚本的三级解释器查找

如果上游有独立的许可声明，以那边为准；这份改动本身沿用本仓库的 MIT。

依赖：

```
pip install -r plugins/peek/requirements.txt
```

需要 `numpy` 和 `Pillow`。Windows 上还要有 PowerShell 5.1 或以上。

仓库里只有 `plugins/peek/data/config.example.json`，**没有可用的 `config.json`**——因为路径跟每台机器不同。用之前先复制一份：

```
copy plugins\peek\data\config.example.json plugins\peek\data\config.json
```

拿到的是：

```json
{
  "python": "",
  "focus": "auto"
}
```

- `python` 留空 → 依次找环境变量 `WHALELIFE_PEEK_PYTHON`、然后 PATH 里的 `python`
- Windows 上 PATH 里的 `python` 常常是应用商店的占位符，一跑就报「边车没跑成」。装了 Python 却报这个，就把 `python` 写成绝对路径
- `focus`：`auto` 按前台窗口挑区域，`whole` 整屏抓
- 改配置不用重启，每次调用重读

参数：`seconds`（2–60，默认 10）、`max_frames`（1–12，默认 6）、`max_width`（400–4096，默认 1600）。

没验过的：`pip install -r requirements.txt` 没真跑过（那会动本机环境），依赖能装上是从机器上已装的包推的；多显示器行为；Linux/macOS 完全没试过。

## mouth 念出来

把文字合成为语音并播放。两种引擎：

| 引擎 | 需要什么 |
|---|---|
| 本地 GPT-SoVITS | 本机跑着 GPT-SoVITS（默认 `http://127.0.0.1:9880`）、一份参考音频和它的文本 |
| DeepSeek 云端 | 一把 DeepSeek API Key；音色 `stella`（女）/ `tide`（男） |

配置页在「插件 → 嘴巴」。`config.example.json` 里所有跟路径、密钥有关的字段都是空的，按你的机器填。

行为说明：

- 念之前会过滤掉代码块、表格、`[[img:]]` 标记和文件路径，路径换成「（略）」
- 长文本按句切成不超过 110 字的段，逐段合成、顺序播放
- 云端返回的 wav 头里有流式占位值（`0xFFFFFFFF`），播放前会按实际长度重算，不改就用 `SoundPlayer` 放不出来
- 播放走 `SoundPlayer.PlaySync`，**系统默认输出设备为空的话会「合成成功但没声音」**，这是 Windows 的坑，不是插件没跑

与其他插件的关系：单独装 `mouth` 只能手动念（页面上的「念一句试试」）或由别的插件调 `mouth_say` 工具。要"说完话自动念"，需要配合 `ear` 插件（在 personal-test 库里）。

没验过的：云端模式只在本人的 key 上试过；`SoundPlayer` 在别的机器上、其他音频驱动下的表现。

---

## 许可

MIT，全文见 `LICENSE`。

这些插件运行于 WhaleLife，仅通过其插件 API 交互，不含上游代码，因此按 MIT 独立发布，不受上游 AGPL 约束。

`peek` 派生自 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)，那部分的归属以其原仓库为准。

## 已知短板汇总

- `ledger`：价格表是手抄的，供应商调价不会自动跟着变
- `peek`：视觉模型用本地 Ollama 的 `qwen3-vl:4b`，没配就报错
- `mouth`：念之前不排队打断，正在念的时候来的新内容会排进队列（最多存 2 条，超过丢最旧的）
- 三个插件都只在 Windows 上跑过
