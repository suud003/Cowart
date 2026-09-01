# Windows packaging resources

`npm run dist:win` builds the production renderer and creates an x64 NSIS
installer under `output/desktop/`.

`run-electron-builder.cmd` deliberately launches the packager with npm's host
Node executable and a Yogurt-specific cache outside the ESM project tree. This
prevents the bundled `node-win-x64` runtime from shadowing electron-builder's
own CommonJS build helpers.

The production canvas is the official `@excalidraw/excalidraw@0.18.1` runtime,
distributed under MIT with its bundled font notices. The retired tldraw source
and packages remain available in the repository for development-time legacy
compatibility, but electron-builder explicitly excludes them from the Windows
installer.

The packaged desktop runtime deliberately lives in `app.asar.unpacked` while
the bootstrap remains in `app.asar`. Codex starts the Yogurt MCP server in a
separate process, and external Node processes cannot execute files through an
Electron ASAR virtual path.

The installer bundles pinned Codex CLI and Node runtimes for its local App
Server and MCP sidecars. It creates desktop and Start Menu shortcuts, while
workspace selection remains owned by the desktop onboarding flow. No global
npm, Node.js, or Codex CLI installation is required after setup.

`yogurt-ai-icon.png` is generated from `public/cowart-logo.svg` by
`scripts/prepare-windows-icon.mjs`. The NSIS license page displays the app's
root MIT `LICENSE`; the packaged runtime separately includes
`licenses/EXCALIDRAW-LICENSE.md` for Excalidraw and its font notices.
