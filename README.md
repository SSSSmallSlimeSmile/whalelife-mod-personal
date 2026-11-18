# WhaleLife 插件（成品）

自己写的、跑通过、可以直接给群友用的 WhaleLife 插件。

**不是 WhaleLife 官方项目，与原作者无关。** 这些是个人写的扩展插件，不改主干代码，放进 `plugins/` 目录重启即可加载。

## 先说清楚：验证范围

下面这些插件和改动，**只在本人那台 Windows 电脑上跑过**。没有在手机上跑过，也没有在第二台电脑上跑过。

具体到每个插件，哪些验过、哪些没验过，写在各自的「状态」里。看到「可用」，意思是"在我这台机器上能用"，不是"在哪都能用"。装到别的机器上遇到问题，属于预期之内，不是谎报。

有疑问或者装不上，直接到仓库开 issue，或者找仓库主人问。这里不代办、不当客服，但会看。

## 目录

| 插件 | 版本 | 做什么 | 状态 |
|---|---|---|---|
| `ledger` | 0.1.0 | 用量账本。扫会话记录里已有的 `request_usage`，页面在「插件 → 账本」，另有只读工具 `ledger_today` | 可用 |
| `peek` | 0.1.0 | 看屏取帧。抓一段屏幕，只留画面真正变化的那几帧，拼成一张图交给视觉模型 | 可用 |
| `comfy` | 0.2.0 | 生图与看图。把 ComfyUI 接成出图后端；`image_view` 把图片文件直接送进上下文，带原图像素坐标 | 可用（**本身不带 ComfyUI**，没装 ComfyUI 只能看图、不能出图） |
| `ear` | 0.1.0 | 麦克风听写。按住热键说话，识别成字投进会话，可选让 `mouth` 念回复 | 能用（依赖本机模型） |
| `chime` | 0.1.0 | 提示音。一轮任务跑完、回复真的发出去后，在电脑上响一声 | 能用（本机验过出声） |
| `mouth` | 0.1.0 | 把一段文字念出来。本地 GPT-SoVITS 或 DeepSeek 云端 TTS 二选一 | 可用（云端模式依赖 key，本地模式依赖本机模型） |

## 安装

把插件目录整个复制到 WhaleLife 的 `plugins/` 下，重启。

```
plugins/
├── ledger/
├── peek/
├── comfy/
├── ear/
├── chime/
└── mouth/
```

`ledger`、`peek` 完全独立，可以只装其中一个。

`ear` 和 `mouth` 有联动，也可以各装各的：

| 装了哪些 | 效果 |
|---|---|
| 只装 `mouth` | 只能手动念：页面上的「念一句试试」，或别的插件调 `mouth_say` 工具 |
| 只装 `ear` | 能听写、能打字进会话，但不会出声 |
| 两个都装 | 按热键说完话，回复自动念出来（`ear` 的「F9 说完后自动念回复」勾上） |

`chime` 与谁都不依赖。

---

## ledger 用量账本

不需要额外依赖。数据来自 `episodes/*.jsonl` 里已经存在的 `request_usage`，只读，不写任何东西。

配置可以不做，不做就用默认值。要改的话先复制一份：

```
copy plugins\ledger\data\config.example.json plugins\ledger\data\config.json
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 设成 `false` 就不加载这个插件 |
| `days` | `7` | 默认看几天，页面上的天数下拉会覆盖它 |
| `max_files` | `400` | 单次最多读多少个 jsonl，防止会话太多把页面拖死 |
| `include_judge_usage` | `false` | 额外统计 `memory/usage-judge.jsonl`。那个文件来自“按难度挑模型”的扩展，**没装那个扩展就保持 `false`**；设成 `true` 而文件不存在也不会报错，只是没东西可读 |

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
  "seconds": 10,
  "max_frames": 6,
  "max_width": 1600,
  "focus": "auto",
  "tier_style": "native",
  "tier_lock": 0,
  "text_layer": false,
  "vision_primary": "chat",
  "vision_backup": "ollama",
  "ollama_model": "qwen3-vl:4b",
  "ollama": "http://127.0.0.1:11434",
  "vram_guard": true,
  "need_vram_mb": 5200,
  "vision_no_think": true,
  "vision_timeout_ms": 120000,
  "run_timeout_ms": 180000
}
```

- `python` 留空 → 依次找环境变量 `WHALELIFE_PEEK_PYTHON`、然后 PATH 里的 `python`
- Windows 上 PATH 里的 `python` 常常是应用商店的占位符，一跑就报「边车没跑成」。装了 Python 却报这个，就把 `python` 写成绝对路径
- `focus`：`auto` 按前台窗口挑区域，`whole` 整屏抓
- `tier_style`：档位整体偏移，`native` / `up` / `down`
- `tier_lock`：`1`–`3` 锁死一档，`0` 不锁（不锁时按画面变化量自动分档）
- 这两项怎么分档、锁档后会压掉几帧，细看 `plugins/peek/README.md`
- `vision_primary`：识图第一选择。`chat` 跟随当前会话模型，也可以填某个对话模型的名字，`ollama` 用本地显卡
- `vision_backup`：第一选择没成（超时、出错、模型不认图）时的备用。`none` 表示不备用
- `vision_no_think`：识图时不让模型先输出一段思考，默认开。思考型模型关掉它反而更快出结果
- 改配置不用重启，每次调用重读

参数：`seconds`（2–60，默认 10）、`max_frames`（1–12，默认 6）、`max_width`（400–4096，默认 1600）。

### 和 eyes 同时开会把显存挤爆

这是本机真撞过的：peek 和 eyes 一起开着，一台 8 GB 显存的笔记本直接卡死，只剩音频还在响。

原因不复杂。`eyes` 是上游自带的一帧看屏插件，默认把本地 `qwen3-vl:4b` 往显卡里塞（大约 4.7–5.2 GB）；它目录下没有 `config.json`，所以一直用写死的默认值。peek 的 `vision_primary`/`vision_backup` 指向 `ollama` 时也要这份显存，GPT-SoVITS 还常住在卡上，几样一挤就溢出了。

所以：

- **二选一。** 想看一段时间里屏幕怎么变，用 peek；只想知道当前这一帧是什么，用 eyes。别同时开
- 停用方式：插件管理里关掉，或者把 `eyes` 写进 `config/plugins.json` 的 `disabled` 数组
- peek 启动时会读一次 `plugins.json`，发现 eyes 还开着就写一条警告到日志，配置页顶部也会挂一条红字
- `vision_primary: "chat"`（默认）不走本地显卡，这条路上省显存；但 eyes 自己那份照吃，跟 peek 走哪条路无关
- `vram_guard` 只在真要去加载本地模型时才检查，管不了 eyes
没验过的：`pip install -r requirements.txt` 没真跑过（那会动本机环境），依赖能装上是从机器上已装的包推的；多显示器行为；Linux/macOS 完全没试过。

## comfy 生图与看图

**这个插件本身不带 ComfyUI。** 它只是 WhaleLife 和 ComfyUI 之间的一个接口：装了本插件、又在自己机器上装了 ComfyUI，才能出图；**没装 ComfyUI，就只能用 `image_view` 看图，不能出图**。插件不下载、不安装、不管理 ComfyUI 的文件，只负责启动它、往里发工作流、取回出图。

准备一份 ComfyUI（[便携版](https://github.com/comfyanonymous/ComfyUI/releases) 最省事），解压到哪都行，然后在配置里指着它。

```
copy plugins\comfy\data\config.example.json plugins\comfy\data\config.json
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `comfy_root` | 空 | ComfyUI 根目录（便携版那种带 `python_embeded` 的）。**留空就用不了出图**，`image_view` 照常 |
| `python` | 空 | 跑边车的解释器。留空依次找 `WHALELIFE_COMFY_PYTHON`、PATH 里的 `python`（跳过应用商店占位符）、常见安装位置、ComfyUI 自带 `python_embeded` |
| `base_url` | `http://127.0.0.1:8188` | ComfyUI 服务地址 |
| `launch_args` | `--lowvram` | 启动参数。8G 卡跑 SDXL 靠它把权重分块换进换出 |
| `timeout_seconds` | `300` | 单次出图最多等多久 |
| `vram_guard` | `true` | 出图前查空闲显存，不够就报警不硬跑 |
| `need_vram_mb` | `3000` | 上面那条的阈值 |
| `auto_start` | `false` | WhaleLife 起来时自动拉起 ComfyUI |
| `stop_on_exit` | `true` | WhaleLife 退出时关掉自己拉起的那份 |

保存后热生效，只有「自动拉起」「退出关掉」要等下次启动/退出。

**两个工具**：

- `comfy_status` — 在不在跑、什么显卡、剩多少显存、有哪些工作流
- `comfy_generate` — 出图。`prompt` 必填，`negative`/`workflow`/`width`/`height`/`seed`/`extra` 可选
- `image_view` — 看图。`path` 必填，`crop`（`x,y,w,h`）、`scale`、`max_width`、`grid` 可选

出图返回的是**文件路径**，看不见画面。要确认画了什么，用 `image_view`。

### image_view 的坐标约定

图上刻度一律标**原图像素**。裁剪和缩放都在脚本里换算完，调用方不用自己乘，也就不容易把屏幕坐标当成原图坐标。

这是踩出来的：之前想核对自己抓的图，只能截屏——拿到的是缩放后的屏幕坐标，和原图差一截，于是遮罩补到了大腿上。现在这个工具直接把原图送进上下文，刻度画在图上。

返回的图只在**当前这一轮**有效，不进历史、不写记忆，也不占后续上下文。

`peek` 会调它：抓完屏想细看某一帧时用。`peek` 的 `plugin.yaml` 里声明了 `optionalDepends: [comfy]`，没装 comfy 就是没这项能力，抓屏本身照常。

### 工作流

`workflows/` 放 ComfyUI 导出的 **API 格式** JSON（画布格式不行，要在 ComfyUI 里另存为 API）。拖进去就能用，不用手填节点 id：插件顺着 `KSampler` 的 `positive` / `negative` 连线认出哪条是正面提示词，再找 `EmptyLatentImage` 的宽高和 `KSampler` 的种子。认出来的槽在 `comfy_status` 里能看到。

仓库里的四份是 SDXL 底模和 Nova Anime IL 的工作流，只是样例，换成你自己的模型后要重新导出。

### 显存

8G 卡跑 SDXL 需要 `--lowvram`（默认）。这套配置下出过 832×1568 的图，约 60 秒。

**语音合成（GPT-SoVITS）常驻约 2.5G。** 两边一起用显存会紧，插件出图前查一次空闲显存，低于 `need_vram_mb` 就拒绝并说明，不硬跑。真不够时先到 voice 插件页停掉语音。查不到 `nvidia-smi` 的机器不拦。

没验过的：只在本人这台 Windows 上跑过；只试过 SDXL 和 SD1.5 的工作流，Flux、LoRA、img2img 没试；「退出关掉」只关本插件自己拉起的进程；认槽逻辑对多阶段工作流没实测。

## ear 麦克风听写

**装之前要准备三样东西**，缺一样就跑不起来：

1. **Python 环境**：SenseVoice 要 `funasr`、`torch`、`soundfile`、`sounddevice`、`scipy`、`numpy`。`sounddevice` 最容易漏，漏了边车自检会报 `No module named 'sounddevice'`
2. **SenseVoice 模型**：`SenseVoiceSmall` 那套权重，存成本地目录
3. **配置**：`data/config.example.json` 复制成 `data/config.json`

```
copy plugins\ear\data\config.example.json plugins\ear\data\config.json
```

| 字段 | 说明 |
|---|---|
| `python` | 跑边车的解释器绝对路径。留空则用 PATH 里的 `python` |
| `sensevoice_dir` | SenseVoice 模型目录。也认环境变量 `WHALELIFE_SENSE_DIR` |
| `device` | 麦克风设备号。`0` 常常不是你要的那个，先 `python -c "import sounddevice; print(sounddevice.query_devices())"` 看清楚 |
| `engine` | 目前只有 `sensevoice` |
| `language` / `initial_prompt` | 识别语言与提示词 |
| `silence` | 静音多久算一句结束，秒 |
| `max_len` | 单句最长秒数 |
| `target_session` | 投进哪个会话，留空就用当前 |
| `speak_reply` | 说完后要不要让 `mouth` 念回复（需要装 `mouth`） |
| `f9_hotkey` | 全局热键，默认 `F9`，支持 `Ctrl+F9`、`Alt+F9` 这类组合 |
| `f9_python` | F9 那个外部进程用哪个解释器，留空用 `pythonw` |
| `auto_start_f9` | 随 WhaleLife 一起拉起 F9 进程 |
| `stop_f9_on_exit` | WhaleLife 关闭时一起收掉 |
| `auto_start` | 监听麦克风那个边车进程要不要随 WhaleLife 一起起，默认 `false` |

**全局热键需要一个外部小进程** `f9/hold_to_talk.py`。浏览器的按键只在网页有焦点时才收得到，所以必须跳出网页。它用 Windows `RegisterHotKey` 占住那个键——**游戏里原本用这个键的功能就用不了了**，换一个键在页面上选。

- 启动：页面上点「启动」，或双击 `f9/start-f9.bat`
- 它按 `f9.json` 里的配置工作，仓库里给的是 `f9.example.json`，复制成 `f9.json` 再改
- 录音结束会调 `/plugins/ear/utter` 投递，然后把识别结果当普通消息进会话

没验过的：非 Windows；别的麦克风设备；whisper 分支代码在但没接过；长时间连续使用会不会积压。

## chime 提示音

一轮任务跑完、回复真的发出去之后，响一声。

```
copy plugins\chime\data\config.example.json plugins\chime\data\config.json
```

| 字段 | 说明 |
|---|---|
| `sound_path` | 音效文件或目录。填目录时每次随机抽一个。**优先用它** |
| `wav_path` | 旧字段。`sound_path` 留空时才回退到它，新配置别填 |
| `log` | 排查用的日志文件路径，留空不写 |
| `min_seconds` | 两次提示音之间的最小间隔，防止连续响 |
| `cooldown_seconds` | 同一段话期间不重复响的冷却时间 |
| `channels` | 哪些通道的回复触发提示音，空数组表示不限 |
| `enabled` | 总开关 |

**长音频别直接放**：超过十秒的会一直占着，把后面的提示音全挡掉。切成 1–4 秒的独立短音丢进一个目录，让它随机抽。

音效文件不入库，自己准备。示例里 `sound_path` 是空的。

没验过的：别的机器、别的音频驱动。声音出不来时先查 Windows 默认输出设备是不是空的——`SoundPlayer` 放不出来就是因为这个，不是插件没跑。

## mouth 念出来

把文字合成为语音并播放。合成引擎下拉里，本机和云端模型都直接列出来：

| 引擎 | 需要什么 |
|---|---|
| 本地 GPT-SoVITS | 本机跑着 GPT-SoVITS（默认 `http://127.0.0.1:9880`）、一份参考音频和它的文本 |
| 云端 | 在「管理 → 模型」登记一条 `tts` 类型，它会自动出现在下拉里，选它即可；也可以选「DeepSeek 云端」在插件页自己填地址和 Key。音色 `stella`（女）/ `tide`（男） |

配置页在「插件 → 嘴巴」。`config.example.json` 里所有跟路径、密钥有关的字段都是空的，按你的机器填。

`auto_scope`：`f9`（默认，只有按 F9 说话才自动念）或 `all`（每句回复都念）。

**引擎下拉里的「文字转语音 · …」就是「管理 → 模型」里登记为 `tts` 的那些**，自动读取，不用在本插件再填一遍。选中某一条后：地址从它的 `base_url` 拼 `cloud_path`（默认 `/tools/tts`），Key 也读那条，换 key 只改一处。选「DeepSeek 云端」则退回 `cloud_url` + `cloud_key`，没填 Key 时再退到主配置里 id 含 `deepseek` 的那个 provider。

云端音色可以点「读取云端音色」去问一次——DeepSeek 没有公开的音色列表接口，但用一个非法音色发请求，它会在报错里把合法值列出来，插件就是解析这个。

行为说明：

- 念之前会过滤掉代码块、表格、`[[img:]]` 标记和文件路径，路径换成「（略）」
- 整段只有代码和表格时不出声，不在耳边念废话
- 长文本按句切成不超过 110 字的段，逐段合成、顺序播放
- 上一段没念完时新来的内容排队，最多存 2 条，超过丢最旧的
- 云端返回的 wav 头里有流式占位值（`0xFFFFFFFF`），播放前会按实际长度重算，不改就用 `SoundPlayer` 放不出来
- 播放走 `SoundPlayer.PlaySync`，**系统默认输出设备为空的话会「合成成功但没声音」**，这是 Windows 的坑，不是插件没跑

与其他插件的关系：单独装 `mouth` 只能手动念或由别的插件调 `mouth_say`。要"说完话自动念"，得配合 `ear`。

网页里打字会不会念，看页面上的「自动念 · 什么时候出声」：选「只有按 F9 说话才念」就只在 `ear` 那几条回，选「每一句回复都念」则网页里也念。两条来源互斥，同一句不会念两遍。

没验过的：云端模式只在本人的 key 上试过；`SoundPlayer` 在别的机器上、其他音频驱动下的表现。

---

## 许可

MIT，全文见 `LICENSE`。

这些插件运行于 WhaleLife，仅通过其插件 API 交互，不含上游代码，因此按 MIT 独立发布，不受上游 AGPL 约束。

`peek` 派生自 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)，那部分的归属以其原仓库为准。

## 已知短板汇总

- `ledger`：价格表是手抄的，供应商调价不会自动跟着变
- `peek`：识图默认跟随当前对话模型；本地 Ollama 那条要显卡有富余，显存不够会被守卫拦下
- `ear`：全局热键会占住那个键，游戏里撞键要换
- `chime`：长音频会把后续提示音全挡掉，建议切成短音
- `mouth`：念的是完整回复再过滤，所以等长回复写完才开口
- `comfy`：本身不带 ComfyUI，没装就只能看图不能出图；重绘（局部重画）没有做成工具，只能出整图
- `comfy`：`image_view` 只画坐标网格，不测像素颜色，报位置得自己看图
- 六个插件都只在 Windows 上跑过
