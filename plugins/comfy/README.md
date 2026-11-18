# 生图（comfy）

把 ComfyUI 接成 WhaleLife 的出图后端。页面上能手动启停服务、看显存、改参数；对话里用工具出图。

**这个插件本身不带 ComfyUI**，只是一个 WhaleLife 和 ComfyUI 之间的接口：装上它、又装了 ComfyUI，才能出图；**没装 ComfyUI 就只能用 `image_view` 看图，不能出图**。

## 装

需要你自己准备一份 ComfyUI（[便携版](https://github.com/comfyanonymous/ComfyUI/releases) 最省事），解压到哪都行。插件不下载、不安装、不管理 ComfyUI 的文件，只负责启动它、往里发工作流、取回出图。

1. 把 `data/config.example.json` 复制成 `data/config.json`
2. 改 `comfy_root` 指向你的 ComfyUI 根目录（留空就用不了出图，`image_view` 照常）
3. 重启 WhaleLife，插件页会出现「生图」

边车只用 Python 标准库，不需要 `pip install` 任何东西。解释器留空就用 PATH 里的 `python`。

## 页面

| 区域 | 干什么 |
|---|---|
| 服务 | 显示在不在跑、版本、显存占用条；三个按钮：启动、停止、刷新 |
| 参数 | 解释器、地址、目录、启动参数、超时、显存阈值、两个伴随开关 |

保存后热生效，只有「伴随」两项要等下次启动/退出。

## 工具

- `comfy_status` — 在不在跑、什么显卡、剩多少显存、有哪些工作流
- `comfy_generate` — 出图。参数：`prompt` 必填，`negative` / `workflow` / `width` / `height` / `seed` / `extra` 可选
- `image_view` — 看图。参数：`path` 必填，`crop`（`x,y,w,h`）/ `scale` / `max_width` / `grid` 可选

出图是长任务，本机 SDXL 25 步约 60 秒，期间不会有别的输出。返回的是**文件路径**，看不到画面内容——要确认画了什么，得另外看图。

## 看图（image_view）

出图只能拿到文件路径，看不见画面。`image_view` 补这一环：给路径，直接把图返回给模型，图上带坐标网格。

```
path      图片完整路径（PNG / JPEG / WebP）
crop      只看一块，x,y,w,h，单位是原图像素
scale     放大倍数 1–12；不填就按 max_width 缩放
max_width 成品最大宽度，默认 1024
grid      网格间距（原图像素）；不填自动，填 0 不画
```

**坐标约定**：图上刻度一律标**原图像素**。裁剪和缩放都在脚本里换算完，调用方不需要自己乘。

这一条是踩出来的：之前想核对自己抓的图，只能用 `see_now` 抓屏幕——拿到的是缩放后的屏幕坐标，和原图差一截，于是遮罩补到了大腿上。现在这个工具直接把原图送进上下文，刻度就画在图上。

返回的图只在**当前这一轮**有效，不进历史、不写记忆。

`peek` 也调它：抓完屏想细看时，用 `image_view` 看具体的帧。peek 的 `plugin.yaml` 里声明了 `optionalDepends: [comfy]`，没装 comfy 就是没这项能力，别的照常。

## 工作流

`workflows/` 放 ComfyUI 导出的 **API 格式** JSON（画布格式不行，要在 ComfyUI 里「另存为 API」）。

拖进去就能用，不用手填节点 id。插件会顺着 `KSampler` 的 `positive` / `negative` 连线认出哪条是正面提示词、哪条是负面，再找 `EmptyLatentImage` 的宽高和 `KSampler` 的种子。这套逻辑是从旧库 `comfyui_workflows.py` 原样搬的。

认出来的槽能在 `comfy_status` 里看到；`comfy_generate` 里没填的槽保留工作流原值，不会清空。

## 显存

8G 卡跑 SDXL 需要 `--lowvram`（默认），把权重分块换进换出。这套配置下本机出过 832×1568 的图，60 秒。

**语音合成（GPT-SoVITS）常驻约 2.5G。** 两边一起用，显存会紧。插件在出图前查一次空闲显存，低于 `need_vram_mb`（默认 3000）就拒绝并说明，不硬跑。真不够时先到 voice 插件页停掉语音。

查不到 `nvidia-smi` 的机器不拦——宁可放过也不误伤。

## 没验证过

- 只在本人那台 Windows 电脑上跑过，没在手机或第二台电脑上验证
- 只试过 SDXL 和 SD1.5 的工作流；Flux、LoRA、img2img 没试
- 「随 WhaleLife 退出关掉」只关本插件自己拉起的进程；你自己开的 ComfyUI 不会被关
- 认槽逻辑对多阶段工作流（先放大再重绘那种）没实测
- `image_view` 的网格只画坐标，不测像素颜色；报位置要自己看图
