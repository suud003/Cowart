# Yogurt AI Desktop (Beta)

Yogurt AI Desktop is the local Electron host for the Yogurt canvas and its Codex Agent workbench. It keeps the editable canvas, agent task stream, approvals, and project-local files in one application.

## Start The App

You need Node.js, npm, Git, and a Codex CLI that is already signed in. The current Windows discovery path expects the default global npm installation unless you provide an override.

```powershell
npm install -g @openai/codex
codex login
npm install
npm run desktop
```

`npm run desktop` builds the renderer before launching Electron. The current directory is used as the default product workspace. To work in another repository:

```powershell
$env:YOGURT_WORKSPACE_ROOT = 'D:\path\to\your-product'
npm run desktop
```

Canvas data is stored under `<workspace>/canvas/`. The saved Codex thread reference lives at `<workspace>/canvas/.yogurt-agent-session.json`, allowing the application to resume the project session on the next launch.

## Windows Codex Discovery

On Windows, Yogurt AI looks for the JavaScript entry created by the global npm package at `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`. This avoids depending on shell wrappers or Windows application aliases.

If Codex is installed elsewhere, set the entry explicitly:

```powershell
$env:YOGURT_CODEX_JS = 'D:\tools\node_modules\@openai\codex\bin\codex.js'
npm run desktop
```

`YOGURT_CODEX_COMMAND` may point to a native executable. Windows `.cmd`, `.bat`, and `.ps1` wrappers are rejected; use `YOGURT_CODEX_JS` for npm installations.

## How The Bridge Works

```text
Yogurt renderer
  -> context-isolated preload API
  -> allowlisted Electron IPC
  -> Yogurt Agent service
  -> Codex App Server over local stdio
       -> bundled cowart_thinking_mcp
       -> project canvas and files
```

The workbench can start or steer an agent turn, stream agent messages, plans, and diffs, surface approvals, and interrupt active work. Before a canvas task is sent, the renderer saves the page and includes its page ID plus exact selected shape IDs. The bundled Yogurt MCP server then gives Codex controlled access to the same project-local canvas.

## Security Boundary

- Electron uses context isolation, renderer sandboxing, web security, and disabled Node integration.
- The renderer can access only `window.yogurtAgent`, the allowlisted `window.cowartMcp` surface, and project metadata exposed through `window.openai.toolOutput`.
- Renderer input cannot choose arbitrary App Server RPC methods, shell commands, processes, MCP servers, or MCP tool names.
- The main process owns `projectDir` and `canvasDir`; any path fields supplied by the renderer are replaced before MCP calls.
- New windows, webviews, unexpected navigation, and renderer permission requests are denied.
- Codex command and file-change requests are returned to the UI for explicit approval.

## Development And Verification

For Vite development, start the renderer in one terminal:

```powershell
npm run dev
```

Then launch Electron from a second terminal with the Vite loopback URL:

```powershell
$env:YOGURT_VITE_DEV_URL = 'http://127.0.0.1:5173'
npx electron ./desktop/launcher.cjs
```

Only loopback HTTP URLs are accepted. Production loading uses the built `dist/index.html`.

Run the end-to-end local probe after installing or upgrading Codex CLI:

```powershell
npm run probe:desktop
```

The probe starts Codex App Server over stdio, creates a temporary thread, verifies the bundled `cowart_thinking_mcp` server, reads the canvas through MCP, archives the temporary thread, and exits.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `YOGURT_WORKSPACE_ROOT` | Product project used for Codex work and canvas persistence |
| `YOGURT_CODEX_JS` | Explicit JavaScript entry for an npm-installed Codex CLI |
| `YOGURT_CODEX_COMMAND` | Native Codex executable override |
| `YOGURT_NODE_COMMAND` | Node executable used for Codex and the bundled MCP server |
| `YOGURT_VITE_DEV_URL` | Loopback Vite URL loaded by Electron during development |
| `YOGURT_DESKTOP_VERSION` | Version reported by the desktop App Server client |
| `YOGURT_DESKTOP_DEBUG` | Set to `1` to mirror renderer load and console errors to the terminal |
| `YOGURT_DESKTOP_CAPTURE_PATH` | Path for a one-shot PNG capture; the app exits after saving |
| `YOGURT_DESKTOP_CAPTURE_DELAY_MS` | Delay before a requested capture, clamped from 250 to 15,000 ms |

## Beta Compatibility

The bridge uses the [Codex App Server](https://learn.chatgpt.com/docs/app-server) JSON-RPC protocol over stdio. App Server remains experimental, and its schemas can change with Codex CLI releases. This implementation is compatibility-tested against `codex-cli 0.144.3`; distributable builds should pin and test the Codex version they ship with. WebSocket transport and experimental App Server capabilities are not enabled.

Normalized renderer events are:

- `agent.delta`
- `plan.updated`
- `diff.updated`
- `approval.requested`
- `turn.started`
- `turn.completed`
- `error`
- `state.changed`

`sendTask` resolves when Codex accepts a new or steered turn. Completion arrives asynchronously through `turn.completed`.
