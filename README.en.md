# Cowart Thinking Canvas

Cowart Thinking Canvas extends Cowart into a source-grounded, non-linear thinking workspace. It organizes documents, knowledge, images, and canvas annotations into editable material, idea, evidence, question, and relationship objects. The agent previews local edits, applies them atomically, explains the result, and can undo a compatible operation. Cowart's tldraw canvas, image generation, AI HTML, Slides, and project-local persistence remain available.

The repository also conforms to [Agent Plugins v1.0.0](https://agent-plugins.org/specification): root-level `plugin.json`, `skills/`, and `mcp.json` provide the portable plugin entry points, while `.codex-plugin/plugin.json`, `.mcp.json`, and `.agents/plugins/marketplace.json` retain Codex-specific interface and installation metadata.

中文说明: [README.md](README.md)

## Features

- Open a native tldraw infinite-canvas widget from Codex; normal use no longer opens a local page through a web browser or the in-app browser.
- Persist canvas pages and image assets in the active project directory.
- Attach local documents and images as material cards with source paths, excerpts, and summaries, keeping source content distinct from agent synthesis.
- Read a compact semantic view of the current page or selection and grow the canvas through typed card, relation, position, and size operations.
- Preview non-trivial batches against a canvas revision, apply atomically, and undo by operation ID without overwriting later work.
- Use the dedicated `AI 圈选` tool to draw a closed freehand region and automatically select its contents, then describe the requested change in the nearby composer. Cowart submits the enclosure, arrows, strike-throughs, grouping marks, annotation text, and selected-region screenshot for local revision and explanation.
- Create AI image slots on the canvas, enter a prompt directly, choose reference images, and let Codex generate an image that replaces the selected slot at the same position and aspect ratio.
- Create a 16:9 `AI HTML` slot, generate a runnable single-file HTML page from a prompt and reference images, and embed it directly on the canvas for further editing and iteration.
- Create `AI Slides` to organize images and HTML into a deck, or ask Codex to generate a specified number of coordinated 16:9 HTML pages; preview the deck with thumbnails or play it fullscreen.
- After annotating an image, submit the annotation screenshot directly from the canvas so Codex can generate a clean revised image beside the original.
- Use Cowart MCP tools to read selection state, save the canvas, insert images or HTML, and save page-local assets.

## Installation

### Install From The Public Fork

```bash
git clone https://github.com/suud003/Cowart.git
cd Cowart
npm install
npm run build
codex plugin marketplace add <absolute-path-to-Cowart>
codex plugin add cowart-thinking-canvas@cowart-thinking-github
```

Start a new Codex task after installing or reinstalling so the skills and MCP tools load cleanly.

### Ask Codex To Install It

Send the following message to Codex:

```text
Please install the Cowart Thinking Canvas plugin from the extracted local directory I provide.
First run npm install and npm run build inside the plugin root, then run
codex plugin marketplace add <absolute-path-to-cowart-thinking-canvas>,
then run codex plugin add cowart-thinking-canvas@cowart-thinking-github and use
codex plugin list to confirm it is enabled. When installation finishes, remind me to start a new
task so Codex loads the new skills and MCP tools.
```

### Manual Install

First install dependencies in the extracted plugin root, then register it as a Codex marketplace:

```bash
npm install
npm run build
codex plugin marketplace add <absolute-path-to-cowart-thinking-canvas>
```

Then install the plugin from that marketplace and verify it:

```bash
codex plugin add cowart-thinking-canvas@cowart-thinking-github
codex plugin list
```

If `cowart-thinking-github` already points to this extracted directory, skip the first command. Start a new Codex task after installing or reinstalling so its skills and MCP tools load cleanly.

## Usage

### Open The Canvas

Ask Codex:

```text
Open the Cowart canvas for this project.
```

Cowart opens a native Codex widget through `render_cowart_canvas_widget`; it no longer needs a localhost page or manual in-app-browser navigation. `scripts/start-canvas.sh` remains only as a local-development fallback.

Canvas data is saved in the active project:

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
```

![Open Cowart canvas in Codex](assets/open-canvas.png)

### Think With Sources And Annotations

1. Put the documents, images, or notes you want to use inside the active project and ask `$cowart-thinking-agent` to import them as material cards. External files are copied into `canvas/materials/` only when explicitly allowed.
2. Ask the agent to extract evidence, questions, assumptions, insights, and decisions from the current page or selection. Non-trivial work is previewed first and applied only if the inspected revision is still current.
3. Choose `AI 圈选` in the top toolbar, draw a closed region, and release. Cowart selects the enclosed objects and focuses the request composer. Enter the instruction and press Enter or click Send; the agent explains its interpretation, changes only the related region, and returns an operation ID for undo.
4. When cards and relations are not expressive enough, the agent reuses Cowart's existing AI HTML or image insertion path to place a previewable chart or visual beside its supporting material.

### Generate A New Image

1. Open the Cowart canvas.
2. Create and select an `AI 图片` slot on the canvas.
3. In the generation panel, enter a prompt, optionally choose one or more reference images, then send the request.

Cowart sends the prompt, reference images, and selected `AI 图片` slot dimensions to Codex. Codex generates an image for that position and aspect ratio, then replaces the `AI 图片` slot with a normal image shape.

![Generate and insert a new image with Cowart](assets/generate-image.png)

### Generate AI HTML

1. Create and select an `AI HTML` slot from the toolbar. New slots default to `1024 × 576` (16:9).
2. Enter a prompt in the generation panel below the slot. You can also choose or paste one or more reference images.
3. Send the request. Codex generates a complete runnable single-file HTML page and embeds it into the selected `AI HTML` slot.

The generated HTML is stored as an embedded canvas page in the current page's `assets/` directory. Select it to download a rendered image, edit text directly, continue revising the HTML with canvas annotations, or generate an image from the HTML and its annotations.

![Edit Cowart AI HTML](assets/edit-html.png)

### Create And Present AI Slides

1. Create `AI Slides` from the toolbar. The default frame is `1048 × 600`, providing room for one `1024 × 576` (16:9) page with `12px` padding on every side.
2. Drag images or HTML from the canvas into the Slides frame. You can also copy an image, select the Slides frame, and paste it; items are arranged horizontally in order.
3. Selecting an empty Slides frame opens its generation panel. Describe the deck, optionally add reference images, and choose 3, 5, 10, or a custom number of pages. The default is 5 pages.
4. After you send the request, Codex generates the requested number of visually and narratively coordinated standalone 16:9 HTML pages and appends them to the current Slides frame. The generation panel is hidden once the frame contains content.
5. Select the Slides frame and click `演示 Slides` to preview and navigate with the thumbnail sidebar or enter fullscreen playback. In fullscreen, use the arrow keys, Space, or click static slide content to advance. Buttons, links, and form controls inside HTML remain interactive, and the playback controls stay at the top.

![Present and navigate Cowart AI Slides](assets/view-slides.png)

### Generate From An Annotation Screenshot

1. Annotate an image on the Cowart canvas.
2. Select the annotated image and click `按标注修改`.
3. Cowart exports a screenshot containing the original image, arrows, and annotation text, then sends it to Codex through the widget bridge.

Codex reads the notes and arrows in the screenshot, generates a clean revised image without annotation artifacts, and places it beside the original. The original image and annotations are not deleted or moved. You can also manually send a Cowart annotation screenshot to Codex and use the same revision workflow.

![Generate a revised image from a Cowart annotation screenshot](assets/annotation-edit.png)

## Skills

- `cowart-thinking-canvas:cowart-thinking-agent`: inspect source-aware context, preview a typed local edit, apply it atomically, explain it, and undo safely.
- `cowart-thinking-canvas:cowart-open-canvas`: open the native Cowart canvas widget.
- `cowart-thinking-canvas:cowart-image-gen`: receive the canvas prompt and reference images, replace the selected `AI 图片` slot with a generated image, or insert a generated image into the current page when no slot is selected.
- `cowart-thinking-canvas:cowart-image-edit`: generate a revised image from a Cowart annotation screenshot submitted from the canvas or provided by the user.

## Local Development

```bash
npm install
npm run dev
npm run build
```

For local development, you can still start the Vite canvas service directly and pass the active user project directory:

```bash
./scripts/start-canvas.sh /path/to/user/project
```

The Vite page is a UI-development surface and does not contain the Codex Agent message bridge. In local preview, AI lasso keeps the selection, copies the instruction, and explains the limitation; use the native Cowart canvas opened by `render_cowart_canvas_widget` to send the request directly to the Agent.

Useful environment variables:

- `COWART_PORT`: local service port, default `43217`.
- `COWART_PROJECT_DIR`: the user project directory that owns the canvas data.
- `COWART_CANVAS_DIR`: canvas data directory, default `$COWART_PROJECT_DIR/canvas`.

## Developer

ZHONG XIN  
zhongxin123456@gmail.com  
https://www.jiqiren.ai

## Open Source, References, And Acknowledgments

This repository is a public fork of [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart). It preserves the GitHub fork relationship and the upstream MIT license. The published fork is maintained at [`suud003/Cowart`](https://github.com/suud003/Cowart).

- [tldraw/tldraw](https://github.com/tldraw/tldraw) provides Cowart's infinite-canvas, shape-editing, and interaction runtime. Version `5.1.1` is pinned and uses the tldraw license, not MIT. Its default terms permit development use only; public production deployment requires an applicable trial, commercial, or alternative license. See the verbatim [`licenses/TLDRAW-LICENSE.md`](licenses/TLDRAW-LICENSE.md).
- [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) is the design reference for toolbar layout, hand-drawn visual language, and interaction details. The Excalidraw editor is not a runtime dependency. Bundled Excalifont files and the Xiaolai subset manifest come from the official `@excalidraw/excalidraw@0.18.1` package; Xiaolai font files load at runtime from a public CDN pinned to that version.
- [Excalifont](https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts), [Xiaolai](https://github.com/lxgw/kose-font), and Assistant font files are distributed under the SIL Open Font License 1.1. See [`src/assets/fonts/FONT-LICENSES.md`](src/assets/fonts/FONT-LICENSES.md) and [`src/assets/fonts/OFL-1.1.txt`](src/assets/fonts/OFL-1.1.txt).

The root `LICENSE` covers Cowart-owned code and the MIT-licensed portion of this fork only. It does not supersede third-party licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details.
