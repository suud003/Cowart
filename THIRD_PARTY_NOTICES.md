# Third-party notices

This repository is a public fork and derivative of [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart), originally published under the MIT License by Twox / ZHONG XIN. The original copyright and license are preserved in the root `LICENSE` file.

## Excalidraw and bundled fonts

[Excalidraw](https://github.com/excalidraw/excalidraw) is the production canvas runtime. The Windows installer includes the official `@excalidraw/excalidraw@0.18.1` package and locally bundled editor fonts/assets. A copy of the Excalidraw MIT license and font notices is included at [`licenses/EXCALIDRAW-LICENSE.md`](licenses/EXCALIDRAW-LICENSE.md).

- Excalidraw source code: MIT License.
- The official font bundle includes Assistant, Cascadia, Comic Shanns, Excalifont, Liberation, Lilita, Nunito, Virgil, and Xiaolai. Each family retains its upstream license and copyright.
- The SIL Open Font License 1.1 text and the project's font notice are included at `src/assets/fonts/OFL-1.1.txt` and `src/assets/fonts/FONT-LICENSES.md`; the complete upstream font sources and notices are linked from `licenses/EXCALIDRAW-LICENSE.md`.

## Legacy tldraw compatibility (development only)

The repository retains the retired tldraw canvas source and tests so maintainers can inspect or migrate older Yogurt AI snapshots. `tldraw` and `@tldraw/*` are development dependencies only; they are explicitly excluded from the Windows installer and are not loaded during the normal Excalidraw startup path. A copy of the applicable development license remains at [`licenses/TLDRAW-LICENSE.md`](licenses/TLDRAW-LICENSE.md) for contributors working with that legacy code.

## Other runtime dependencies

[PptxGenJS](https://github.com/gitbrent/PptxGenJS) is used only through its browser build to generate standards-compliant OOXML PowerPoint files. Its package explicitly disables the Node-only `image-size` parser in browser bundles; Yogurt AI's production bundle was verified not to include that parser. PptxGenJS is distributed under the MIT License and retains its own copyright and license terms.

Other production packages are installed through npm and retain their own licenses, including React, Model Context Protocol SDKs, html2canvas, Lucide, Zod, Tiptap/ProseMirror, Vite, and their transitive dependencies. Refer to each installed package's `package.json` and license file for the applicable terms.

The root MIT license does not replace any third-party license described above.
