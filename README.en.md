# Yogurt AI

<p align="center">
  <img src="assets/app-icon.png" width="84" alt="Yogurt AI icon">
</p>

<p align="center"><strong>The official Excalidraw editor, with AI only when you ask for it.</strong></p>

<p align="center">Official Excalidraw editor · Multi-canvas project tree · Native editable AI output · Codex Agent · Project-local storage</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#windows-desktop-app">Windows download</a> ·
  <a href="#how-to-use-it">Quick start</a> ·
  <a href="#local-development">Local development</a>
</p>

Yogurt AI embeds the official [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw) runtime and UI. With AI off, the editor, tools, keyboard shortcuts, style panel, and `.excalidraw` data model still come from the official component, while project canvas navigation lives in Excalidraw's official Sidebar.

When you need AI, open Codex Agent from the application menu or keyboard. Cards, text, frames, and bound arrows created by the Agent are still native Excalidraw elements. Select, move, rewrite, recolor, resize, reconnect, undo, and export them with the standard editor.

<p align="center">
  <img src="docs/images/yogurt-ai-native-editable-diagram.png" width="100%" alt="A native Excalidraw card selected in Yogurt AI with the official style panel open">
</p>

## Two modes, one multi-canvas project

### AI off: the official Excalidraw experience

- The editor, tools, shortcuts, and style panel retain the official Excalidraw experience.
- Project canvas navigation lives in Excalidraw's official Sidebar; the AI panel and preset prompts stay hidden.
- Use the standard selection, free-draw, rectangle, diamond, ellipse, arrow, text, image, eraser, and frame tools.
- Select an element to change its font, font size, text color, stroke, fill, width, dash, roughness, opacity, and arrowheads in the official style panel.
- Keep Excalidraw's undo/redo, zoom, shortcuts, import/export, and native editing behavior.

<p align="center">
  <img src="docs/images/yogurt-ai-official-excalidraw.png" width="100%" alt="The official Excalidraw editor with AI turned off">
</p>

### AI on: Excalidraw + Codex Agent

Choose `Yogurt AI → 切换 AI 模式` from the application menu, or press:

- Windows / Linux: `Ctrl + Shift + A`
- macOS: `Cmd + Shift + A`

The Agent opens beside the same editor. Toggle it off to return immediately to the clean canvas.

<p align="center">
  <img src="docs/images/yogurt-ai-agent-mode.png" width="100%" alt="Yogurt AI Codex Agent beside the official Excalidraw editor">
</p>

## One project, multiple canvases

Each project can contain multiple independent Excalidraw canvases, organized as a parent/child tree in the official Sidebar. Open canvas navigation with:

- Windows / Linux: `Ctrl + Shift + O`
- macOS: `Cmd + Shift + O`

Create root or child canvases, switch between them, rename them, move them within the hierarchy, and delete canvases you no longer need. When a parent canvas is deleted, its children are promoted to the deleted canvas's parent so their content is not removed with it.

Every canvas persists its own scene and revision independently. Editing a canvas or running the Agent on it cannot overwrite another canvas in the same project.

## AI output is native Excalidraw

| Content | Generated result |
| --- | --- |
| Cards | Native `rectangle` elements with bound text |
| Sections | Native `frame` elements that organize related content |
| Relations | Native `arrow` elements with bound endpoints and editable labels |
| Layout | Automatic reading order, hierarchy, spacing, ports, and obstacle avoidance |
| Styling | Fully editable through Excalidraw's official style panel |
| Revisions | Semantic updates preserve user-edited fonts, colors, strokes, and geometry |
| Traceability | Stable semantic IDs and source details stay attached to Agent elements |

Every generated element remains independently selectable and editable with Excalidraw's standard move, style, binding, undo, and export behavior.

## How to use it

1. Open Yogurt AI from the desktop shortcut and choose a project folder on first launch.
2. Press `Ctrl + Shift + O` to open canvas navigation. Create root or child canvases as needed, then switch and organize them in the project tree.
3. Draw directly in Excalidraw. Select any element to restyle it with the official panel.
4. Press `Ctrl + Shift + A`, or use the `Yogurt AI` application menu, when you want the Agent.
5. Describe the structure you want to create or reorganize. For example:

```text
Draw an editable left-to-right loop: user submits a request → AI detects intent →
AI generates a draft → the user edits it → AI regenerates.
Use dashed arrows for failure paths.
```

```text
Reorganize the selected cards. Preserve my edited text and colors, create clear layers,
route arrows around nodes, and move exceptions into a separate frame.
```

6. Turn AI mode off and continue editing, exporting, or sharing the document with the full Excalidraw toolset.

This Beta focuses on the official Excalidraw editor, multi-canvas project trees, and native editable AI diagrams.

## Windows desktop app

Regular users do not need Node.js, Git, or a global Codex CLI.

1. Download `Yogurt-AI-Beta-Setup-0.4.0-x64.exe` from the [Yogurt AI Beta 0.4.0 release](https://github.com/suud003/Cowart/releases/tag/v0.4.0%2Bcodex.20260902).
2. Run the installer and choose a project folder on first launch.
3. Press `Ctrl + Shift + A` to open Codex Agent. If needed, finish Codex authorization in the official browser flow.

The current Beta installer is unsigned, so Windows SmartScreen may show a warning. Download it only from this repository's Releases page and verify the published SHA-256.

## Codex plugin

```bash
git clone https://github.com/suud003/Cowart.git
cd Cowart
npm install
npm run build
codex plugin marketplace add .
codex plugin add cowart-thinking-canvas@cowart-thinking-github
```

Then describe the diagram you need:

```text
Open Yogurt AI and turn this requirement into a native editable Excalidraw flowchart.
```

`cowart-semantic-diagram` writes native Excalidraw elements and uses `html-line-svg` layout rules to keep hierarchy, spacing, and connections readable.

## Local development

```bash
npm install
npm run dev
npm run build
npm run desktop
```

Run the complete local verification with:

```bash
npm run check
npm test
npm run build
```

The Vite page is for editor UI development. `npm run desktop` launches the complete desktop app with the Codex Agent bridge. See [desktop/README.md](desktop/README.md) for implementation and troubleshooting notes.

## Data and safety

- The project tree and active canvas are recorded in `canvas/project.json`.
- Each canvas is stored independently at `canvas/canvases/<canvasId>/scene.excalidraw` using the standard Excalidraw document structure.
- Projects that still use the legacy `canvas/yogurt.excalidraw` file migrate lazily on first open. The original file is retained, and its canvas content is copied unchanged into the new default canvas.
- Per-canvas revision checks and atomic writes prevent canvases from overwriting one another and stop stale updates from silently replacing the latest scene.
- Agent operations write native elements. User-edited fonts, colors, strokes, and positions become the latest state for later operations.
- Automatic mode only continues reversible canvas work inside the active workspace; it does not approve external authorization, credentials, purchases, or destructive actions.
- The desktop app connects to Codex App Server locally over stdio.

## Technology and acknowledgements

Yogurt AI uses the official [Excalidraw](https://github.com/excalidraw/excalidraw) React package as its editor and canvas runtime instead of recreating a similar interface.

- `@excalidraw/excalidraw` provides the official editor UI, tools, native element model, style panel, and serialization.
- `cowart-semantic-diagram` turns source material into native editable semantic diagrams.
- `html-line-svg` supplies relation grammar, reading order, hierarchy, spacing, ports, and routing rules.
- Excalifont, Xiaolai, and Assistant fonts use the SIL Open Font License 1.1.
- Excalidraw uses the MIT License; see [licenses/EXCALIDRAW-LICENSE.md](licenses/EXCALIDRAW-LICENSE.md).

This repository is a public fork of [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart), maintained at [suud003/Cowart](https://github.com/suud003/Cowart). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for complete notices.

## Maintainer

Yogurt AI is maintained at [suud003/Cowart](https://github.com/suud003/Cowart), with the original authorship and license preserved.
