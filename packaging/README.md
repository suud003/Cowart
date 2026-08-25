# Windows packaging resources

`npm run dist:win` builds the production renderer and creates an x64 NSIS
installer under `output/desktop/`.

`run-electron-builder.cmd` deliberately launches the packager with npm's host
Node executable and a Yogurt-specific cache outside the ESM project tree. This
prevents the bundled `node-win-x64` runtime from shadowing electron-builder's
own CommonJS build helpers.

This package is a local development/internal-testing Beta. The bundled tldraw
license does not authorize production distribution; obtain an appropriate
tldraw license before shipping Yogurt AI to end users.

The packaged desktop runtime deliberately lives in `app.asar.unpacked` while
the bootstrap remains in `app.asar`. Codex starts the Yogurt MCP server in a
separate process, and external Node processes cannot execute files through an
Electron ASAR virtual path.

The installer bundles pinned Codex CLI and Node runtimes for its local App
Server and MCP sidecars. It creates desktop and Start Menu shortcuts, while
workspace selection remains owned by the desktop onboarding flow. No global
npm, Node.js, or Codex CLI installation is required after setup.

`yogurt-ai-icon.png` is generated from `public/cowart-logo.svg` by
`scripts/prepare-windows-icon.mjs`. The same script copies
`licenses/TLDRAW-LICENSE.md` byte-for-byte to the `.txt` form accepted by the
NSIS license page. Packaging does not alter tldraw's license enforcement or
watermark.
