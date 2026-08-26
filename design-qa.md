# Design QA

## Evidence

- Visual source: `C:\Users\TIANYI~1\AppData\Local\Temp\codex-clipboard-32b90f08-8d4d-41ac-a0d7-bcada4d8b83a.png` (`1488×1058`).
- Full desktop implementation: `qa/atelier-desktop-release.png`, captured from the real Electron renderer at a `1488×1058` BrowserWindow and normalized to `docs/images/yogurt-ai-workspace.png`.
- Open Agent state: `qa/atelier-agent-case.png`, captured from the real Electron renderer with the visual project case still visible behind the overlay.
- Minimum supported desktop window: `qa/atelier-min-1024x720-v2.png`, captured from a `1024×720` BrowserWindow.
- Same-viewport comparison: `qa/atelier-comparison-final.png`, with the visual source and implementation rendered together at `1488×1058` per side.

## Fidelity surfaces checked

- Layout: the black 78 px application rail, 56 px breadcrumb bar, three editorial canvas columns, visual hierarchy, evidence stack, lower-right Codex entry, and floating Agent workbench match the selected direction.
- Typography: serif section titles, restrained sans-serif product copy, and handwriting-style notes keep distinct roles without clipped headings or broken vertical text.
- Color and surfaces: warm canvas paper, near-black navigation, cobalt interaction accents, amber evidence highlight, pale-blue mechanism note, and pink risk notes remain consistent across canvas and Agent states.
- Imagery: the rainy-city hero, alley, interior, and hand-drawn branch diagram are bundled raster assets with intentional crops and optimized WebP delivery. No placeholder boxes or synthetic SVG stand-ins are used.
- Icons: application navigation and actions use the Phosphor icon family; existing tldraw tools retain their native icon system.
- Responsive behavior: the `1024×720` pass scales the showcase composition as one unit so the three-column case remains readable and no longer clips outside the visible canvas. Narrow browser/widget layouts retain the single-column and modal-Agent fallbacks.
- State treatment: the source screenshot includes an actively selected research card. The shipped onboarding canvas uses a neutral state instead of baking a fake selection into non-interactive sample content; real tldraw selection and contextual tools remain functional above it.

## Comparison history

1. The first Electron capture exposed a legacy style-panel overlay and an inherited empty-state title rule that expanded “事件触发” into a clipped vertical word. Both were removed from the selected visual direction.
2. The second pass replaced the improvised branch text with a real hand-drawn raster note, aligned the three evidence cards, and converted the Codex launcher into a persistent status surface.
3. The Agent pass exposed a dark legacy setup card and an oversized empty gap. Specific light-theme overrides and a flexible welcome layout made the connection state, quick tasks, complete conversation area, and composer visible together.
4. The final source-versus-implementation comparison aligned the palette, evidence stack, branch note, typography, and canvas margins. A separate `1024×720` pass found and fixed minimum-window clipping with a height-aware composition scale.

## Functional and accessibility verification

- Side-rail navigation, canvas upload access, undo, redo, share, and Agent open/close controls remain real buttons with accessible names and visible focus treatment.
- The Agent launcher continues to distinguish unread replies from blocking requests; blocking interactions remain prominent in the expanded panel and background notifications remain supported.
- Agent messages are not line-clamped, retain line breaks, and remain scrollable. Compact Agent mode retains dialog semantics, focus containment, Escape dismissal, and focus restoration.
- Reduced-motion handling, keyboard focus indicators, semantic connection colors, and practical mobile tap targets remain present.
- Renderer captures completed without logged console or load errors.
- `npm run quality` passed: plugin metadata checks, syntax checks, 217 automated tests, production build, MCP probe, analytics probe, and GA4 probe.

## Remaining findings

- P0: none.
- P1: none.
- P2: none.

final result: passed
