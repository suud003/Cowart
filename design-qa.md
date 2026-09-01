# Release Design QA — Yogurt AI × Official Excalidraw

最后核对：2026-09-02

目标版本：`0.3.0+codex.20260902`

编辑器基线：官方 `@excalidraw/excalidraw@0.18.1`

## 本次验收范围

本轮只验收一件事：Yogurt AI 是否以官方 Excalidraw 编辑器作为产品本体，并在 AI 模式开启后生成仍可由用户继续编辑的原生 Excalidraw 图形。

- AI 关闭：显示官方嵌入式 Excalidraw 编辑器 UI 与运行时，不显示 Yogurt AI 侧栏、快捷任务或预制提示词。
- AI 开启：保留同一个 Excalidraw 编辑器，在右侧增加 Codex Agent 工作区。
- AI 生成结果：使用 Excalidraw 原生 `frame`、`rectangle`、`text`、`arrow` 与绑定关系，不以截图、HTML/SVG 图块或另一套画布对象冒充可编辑内容。
- 用户编辑：字体、字号、文字色、描边色、背景色、线宽、线型、粗糙度、透明度、圆角与箭头等继续通过官方属性面板修改。
- 非目标：不宣称复刻 excalidraw.com 的多人协作、云端房间或官方托管后端；本次验收对象是官方嵌入式编辑器 UI/运行时及 Yogurt AI 的本地 AI 扩展。

官方实现依据：

- [Excalidraw 0.18.1 release](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1)
- [@excalidraw/excalidraw package](https://www.npmjs.com/package/@excalidraw/excalidraw)
- [Excalidraw integration API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api)

## 真实界面证据

以下三张图片均为当前 Electron 渲染器的实际内容截图，尺寸均为 `1424 × 835`，不是概念稿或重新绘制的宣传图。

| 状态 | 截图 | 核对结果 |
| --- | --- | --- |
| AI 关闭 | [`docs/images/yogurt-ai-official-excalidraw.png`](docs/images/yogurt-ai-official-excalidraw.png) | 仅见官方菜单、工具栏、素材库、缩放、撤销/重做与帮助入口；没有 Yogurt AI 可见叠层。画面中的标题与流程图均为画布内容。 |
| 原生元素编辑 | [`docs/images/yogurt-ai-native-editable-diagram.png`](docs/images/yogurt-ai-native-editable-diagram.png) | 选中原生卡片后，官方属性面板可见描边、背景、线宽、边框样式、线条风格、边角、字体、字号与对齐等控件。 |
| AI 开启 | [`docs/images/yogurt-ai-agent-mode.png`](docs/images/yogurt-ai-agent-mode.png) | 同一个官方编辑器保留在左侧；Codex Agent 作为独立右栏出现，画布内容自动适配剩余可视区域。 |

## 实现核对

### 1. 官方编辑器边界

- `src/main.jsx` 直接加载 `@excalidraw/excalidraw/index.css`，并设置本地 `EXCALIDRAW_ASSET_PATH`。
- `src/NativeExcalidrawApp.jsx` 直接渲染官方 `<Excalidraw />` 组件，没有重新实现工具栏或属性面板。
- 生产依赖锁定 `@excalidraw/excalidraw` `0.18.1`；旧画布兼容包仅保留在开发依赖中，不进入生产运行时。
- `src/nativeExcalidraw.css` 只负责全屏容器、AI 双栏和窄屏 Agent 覆盖层，不改造官方编辑器视觉语言。

### 2. AI OFF / ON

- AI 模式默认关闭，并持久化明确的开/关状态。
- 关闭时，Agent 组件不会挂载；切换入口由桌面菜单及 `Ctrl/Cmd + Shift + A` 提供，不污染官方画布 UI。
- 开启时，Agent 侧栏宽度限制在 `330–390 px`，其样式放在 Shadow DOM 中，避免覆盖 Excalidraw 的 CSS。
- 打开侧栏后，场景按剩余画布区域重新适配；关闭后恢复开启前的缩放与滚动位置。
- `600 px` 以下窗口使用全屏 Agent 覆盖层，避免双栏将编辑区压缩到不可用。

### 3. 原生可编辑元素

- AI 卡片由原生矩形及其绑定文本组成；语义分区使用原生 frame；关系使用原生 arrow 及绑定标签。
- 文本在写入场景前按卡片宽度换行，避免长中文越过卡片边界。
- 连线使用边界端口和正交路径，绕开无关卡片；端点移动、缩放或删除后会重新计算路径与绑定。
- 循环、回边、平行关系和 fan-out 分配独立 lane，避免所有连线堆叠在同一条路径上。
- 后续 AI 只更新语义或文字时，会保留用户手动修改的字体、字号、颜色、填充、线型、线宽、粗糙度、透明度、位置、尺寸与绑定。
- 画布保存为标准 `.excalidraw` 文档；旧版画布数据只执行一次迁移，不改变新的生产存储格式。

### 4. 字体与安全边界

- 官方字体资源从 Excalidraw `dist/prod/fonts` 同步到 `public/excalidraw-assets/fonts`。
- 本轮核对为 `234` 个文件、`13,107,068` 字节，与安装依赖中的官方字体目录逐文件 SHA-256 一致，差异为 `0`。
- 桌面端保持严格 CSP：字体只允许本地与 `data:` 来源。Excalidraw 内部登记的远程字体 fallback 会被 CSP 拒绝，但本地字体完整可用；该控制台提示不是本地字体加载失败。

## 功能与视觉检查结果

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| AI 关闭时无 Yogurt 可见 UI | PASS | AI 关闭截图；组件条件挂载 |
| 官方工具栏与官方属性面板可用 | PASS | AI 关闭截图、原生元素编辑截图 |
| 字体、颜色、线框样式可编辑 | PASS | 原生元素编辑截图；样式保留自动测试 |
| AI 开启后仍是同一编辑器 | PASS | AI 开启截图；单一 `<Excalidraw />` 实例 |
| AI 输出为原生对象而非图片图块 | PASS | 原生元素、绑定和持久化自动测试 |
| 中文文本保持在卡片内 | PASS | 文本换行自动测试；三张实际截图 |
| 连线避障及移动后重算 | PASS | 正交避障、移动/缩放后重路由自动测试 |
| 用户手动样式不会被语义更新覆盖 | PASS | 字体、颜色、线型、几何和绑定保留自动测试 |
| 正常桌面构建可启动 | PASS | 多 chunk 生产构建后的 `1424 × 835` Electron 实际截图；未出现未捕获的 renderer `ReferenceError` |

## 自动化与发布门禁

| 命令 / 门禁 | 当前状态 | 说明 |
| --- | --- | --- |
| `npm test` | PASS | 2026-09-02 本地实跑：`320/320` 通过，`0` 失败、`0` 跳过。 |
| `npm run quality` | PASS | 插件元数据、语法检查、`320/320` 测试、生产构建、原生 MCP widget、analytics 与 GA4 探针全部通过。 |
| `npm run dist:win` | PASS | 已生成 `Yogurt-AI-Beta-Setup-0.3.0-x64.exe`（`337,456,826` 字节）及 blockmap（`324,148` 字节）。 |
| `npm run verify:packaged` | PASS | 校验 `399` 个源码/打包文件，内置 Codex stdio 与 Yogurt MCP 可用；真实打包 renderer 以退出码 `0` 完成 `1424 × 895` 截图，无未捕获启动错误。 |
| 安装包 SHA-256 | PASS | `4E3240915F60A6DF1A74FA06313B6901DEB1CA6B019980EE9083014E45194683`，已与 `.sha256.txt` 复核一致。 |
| GitHub Release | 待发布 | 仅待最终提交进入 `main` 后创建 `v0.3.0+codex.20260902` 非预发布 Release，并明确上传 exe、blockmap 与 SHA-256 文件。 |

## 结论与剩余项

- 视觉与交互目标：通过。当前产品表面是官方 Excalidraw 编辑器；AI UI 只在 AI 模式开启后出现。
- 原生可编辑性目标：通过。图中卡片、文本、frame、箭头和标签均为 Excalidraw 原生元素，并保留官方样式编辑能力。
- P0/P1 设计问题：本轮截图与实现核对未发现。
- 发布状态：**发布验证通过**。质量、Windows 打包、打包后真实启动及哈希校验均已完成；剩余动作仅为提交 `main` 并创建对应 GitHub Release。
