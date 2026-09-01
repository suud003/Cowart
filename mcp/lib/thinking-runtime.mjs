import { readCowartCanvasState } from "./canvas-storage.mjs";
import * as excalidrawRuntime from "./excalidraw-thinking-canvas.mjs";

let legacyRuntimePromise;

function loadLegacyRuntime() {
  legacyRuntimePromise ??= import("./thinking-canvas.mjs");
  return legacyRuntimePromise;
}

async function runtimeFor(args = {}) {
  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  return !state.snapshot || state.snapshot.type === "excalidraw"
    ? excalidrawRuntime
    : loadLegacyRuntime();
}

export async function getThinkingContext(args = {}, options = {}) {
  return (await runtimeFor(args)).getThinkingContext(args, options);
}

export async function applyThinkingOperations(args = {}, options = {}) {
  return (await runtimeFor(args)).applyThinkingOperations(args, options);
}

export async function undoThinkingOperation(args = {}, options = {}) {
  return (await runtimeFor(args)).undoThinkingOperation(args, options);
}

export async function importThinkingMaterial(args = {}, options = {}) {
  return (await runtimeFor(args)).importThinkingMaterial(args, options);
}
