# WhaleLife 插件（成品）

自己写的、验过的、可以直接给群友用的 WhaleLife 插件。

**不是 WhaleLife 官方项目，与原作者无关。** 这些是我个人写的扩展插件，不改主干代码，放进 `plugins/` 目录重启即可加载。

## 目录

| 插件 | 版本 | 做什么 |
|---|---|---|
| `ledger` | 0.1.0 | 用量账本。扫描会话记录里已有的 `request_usage`，页面在「插件 → 账本」，另有一个只读工具 `ledger_today` |
| `peek` | 0.1.0 | 看屏取帧。抓一段屏幕，只保留画面真正变化的那几帧，拼成一张图交给视觉模型 |

## 安装

把插件目录整个复制到 WhaleLife 的 `plugins/` 下，重启。

```
plugins/
├── ledger/
└── peek/
```

### ledger

不需要额外依赖，不需要配置。数据来自 `episodes/*.jsonl` 里已经存在的 `request_usage`，只读，不写任何东西。

价格表在 `prices.ts`，按 2026-11-16 的价目核过。**金额是参考值，不是账单**——按价目重算，和供应商实际扣费可能不同。

用量不完整的记录（峰谷时段、中转没上报缓存）只给区间，不取上界。这是踩过的坑：取上界会把某小时的金额放大三倍以上。

### peek

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

默认按前台窗口挑区域：画面没变的时间不留帧；窗口占屏 8% 以下当噪点整屏抓，超过 92% 整屏抓。

## 许可

MIT，全文见 `LICENSE`。

这些插件运行于 WhaleLife，仅通过其插件 API 交互，不含上游代码，因此按 MIT 独立发布，不受上游 AGPL 约束。

## 已知短板

- `ledger`：价格表是手抄的，供应商调价不会自动跟着变
- `peek`：视觉模型用的是本地 Ollama 的 `qwen3-vl:4b`，没配就会报错；抓帧依赖 `ImageGrab`，多显示器下的行为没验过
