# Yogurt AI Desktop（Beta）

Yogurt AI Desktop 把可编辑无限画布与 Codex Agent 工作台装进同一个 Windows 应用。普通用户不需要准备 Node.js、Git、npm 或全局 Codex CLI。

## 安装并开始使用

1. 获取 Windows x64 安装包 `Yogurt-AI-Beta-Setup-<version>-x64.exe`。当前安装包由维护者或本地构建流程提供；只有 GitHub Releases 页面实际出现附件时，才代表它已经公开上传。
2. 双击安装包并完成安装。安装程序会创建桌面和开始菜单快捷方式，也允许选择安装目录。
3. 第一次启动时，选择一个产品文件夹作为 Yogurt AI 工作区。画布、页面素材、生成文件和项目会话都会保存在该文件夹中。
4. 打开画布后，右侧 Codex Agent 会使用应用内置、经过兼容性验证的 Codex 与 Node 运行时自动连接，并复用当前电脑已有的 Codex 登录状态。未登录时，点击面板里的“登录 Codex”，在浏览器完成官方授权即可。

如果暂时不选择工作区，应用仍会正常打开并展示使用引导；可以稍后在 Agent 面板点击“选择文件夹”。已进入项目后，也可以点击项目上下文中的“更换”切换工作区，应用会安全重启并加载新项目。

如果 Codex 尚未登录，面板会直接发起 [Codex App Server 官方管理的浏览器登录流程](https://learn.chatgpt.com/docs/app-server#auth-endpoints)，授权完成后通过通知自动连接；安装版无需调用 PATH 中的 `codex login`。组件缺失或其他连接异常仍会单独显示并提供“重新检测”。画布读写不依赖 Agent 启动，因此 Codex 暂时不可用时仍可打开和编辑本地画布。

## 当前 Beta 提示

- 当前本地 Beta 安装包未进行代码签名，Windows SmartScreen 可能显示“Windows 已保护你的电脑”。仅运行来自可信渠道、文件名和校验信息与维护者提供内容一致的安装包。
- 卸载应用不会删除用户选择的工作区或其中的画布数据。
- 当前 Windows 构建使用官方 `@excalidraw/excalidraw@0.18.1` 作为画布运行时；关闭 AI 模式时就是原生 Excalidraw 编辑器，开启 AI 模式后才显示 Yogurt Agent。旧 tldraw 代码仅保留给开发期兼容测试，不会进入安装包。
- Codex App Server 仍可能随 Codex 版本演进，因此安装包固定并验证配套运行时，而不是依赖用户电脑中的随机全局版本。

## 本地数据与安全边界

标准 Excalidraw 画布保存在 `<workspace>/canvas/yogurt.excalidraw`，Codex 项目会话引用保存在 `<workspace>/canvas/.yogurt-agent-session.json`。Yogurt AI 不会把启动终端的当前目录默认为用户项目；首次选择会持久化到应用设置中。

桌面桥接的边界如下：

- Electron 开启 context isolation、renderer sandbox 与 web security，并关闭 renderer 的 Node 集成。
- 官方 Excalidraw 的 PNG 复制仅为当前受信主页面开放系统剪贴板写入；剪贴板读取、子页面与外部页面仍被拒绝。
- Renderer 只能访问经过白名单约束的 Yogurt Agent、画布工具与工作区选择 IPC。
- Renderer 不能选择任意 App Server RPC、Shell 命令、进程、MCP Server 或白名单外工具。
- “登录 Codex”只调用固定的 `account/login/start`，主进程仅会打开 App Server 返回、且通过 HTTPS 与 OpenAI/ChatGPT 域名校验的授权地址；授权地址不会返回给 Renderer。
- 主进程拥有 `projectDir` 与 `canvasDir`；Renderer 传入的同名路径不会覆盖它们。
- Codex 的文件修改与命令执行请求会回到工作台，由用户批准、拒绝或中断。
- Yogurt AI 不调用 `chatgpt.com/backend-api/...` 等 ChatGPT 内部接口。Agent 通过本机 stdio Codex App Server 工作；未来若增加直接模型 API 集成，必须使用公开的 `https://api.openai.com/v1/responses` 并通过 API Key 鉴权。

```text
Yogurt renderer
  -> context-isolated preload API
  -> allowlisted Electron IPC
  -> Yogurt Agent service
  -> Codex App Server over local stdio
       -> cowart_thinking_mcp
       -> selected workspace canvas and files
```

## 开发者：从源码启动

以下内容仅供开发和调试。安装包用户无需执行这些命令。

```powershell
git clone https://github.com/suud003/Cowart.git
cd Cowart
npm install
npm run desktop
```

首次运行会打开系统目录选择器。开发时也可以预先指定项目：

```powershell
$env:YOGURT_WORKSPACE_ROOT = 'D:\path\to\your-product'
npm run desktop
```

只有在调试外部 Codex CLI 时，才需要全局安装或覆盖入口：

```powershell
npm install -g @openai/codex
codex login
$env:YOGURT_CODEX_JS = "$env:APPDATA\npm\node_modules\@openai\codex\bin\codex.js"
npm run desktop
```

Vite 联调：

```powershell
npm run dev
$env:YOGURT_VITE_DEV_URL = 'http://127.0.0.1:5173'
npx electron ./desktop/launcher.cjs
```

仅接受 loopback HTTP 开发地址。生产模式从应用资源中加载 `dist/index.html`，不依赖启动命令所在目录。

## 开发者：构建 Windows 安装包

```powershell
npm run dist:win
```

NSIS 安装包输出到 `output/desktop/`，文件名为 `Yogurt-AI-Beta-Setup-<version>-x64.exe`。这是本地构建产物；构建完成不等于已经上传到 GitHub Releases。

桌面端会按应用版本保存 Codex Agent 会话。升级后首次执行会自动创建干净的新会话，避免旧版本 Skill 路径、历史上下文或协议状态污染新任务；同一版本内仍会继续当前项目会话。

验证未打包与打包运行时：

```powershell
npm run probe:desktop
npm run probe:clipboard
npm run verify:packaged
```

打包版本把固定 Codex CLI、Node 运行时与 MCP 运行文件放在可执行的 unpacked resources 中，避免从 Electron ASAR 虚拟路径或用户的当前工作目录启动子进程。

## 开发环境变量

| 变量 | 用途 |
| --- | --- |
| `YOGURT_WORKSPACE_ROOT` | 覆盖首次启动选择的产品工作区 |
| `YOGURT_CODEX_JS` | 调试外部 Codex CLI 时指定 JavaScript 入口 |
| `YOGURT_CODEX_COMMAND` | 调试时指定原生 Codex 可执行文件 |
| `YOGURT_NODE_COMMAND` | Codex 与 MCP 使用的 Node 可执行文件 |
| `YOGURT_VITE_DEV_URL` | Electron 开发模式加载的 loopback Vite 地址 |
| `YOGURT_DESKTOP_VERSION` | App Server 客户端上报的桌面版本 |
| `YOGURT_DESKTOP_DEBUG` | 设为 `1` 时把 renderer 错误输出到终端 |
| `YOGURT_DESKTOP_CAPTURE_PATH` | 保存一次性桌面截图并退出 |
| `YOGURT_DESKTOP_CAPTURE_DELAY_MS` | 截图前等待时间，限制在 250–15,000 ms |
| `YOGURT_DESKTOP_CAPTURE_AGENT_PANEL=1` | 截图前打开 Codex Agent 面板，用于真实界面回归 |
| `YOGURT_DESKTOP_CAPTURE_AUTO_ADVANCE=1` | 截图前打开面板并启用“自动推进画布”，用于真实界面回归 |

桌面桥接基于 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 的本机 stdio 协议，并使用其 `account/read`、`account/login/start` 与登录完成通知实现应用内授权。当前安装包固定并验证 `@openai/codex 0.144.3`；升级依赖后应重新执行桌面与打包探针。
