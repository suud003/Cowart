export const COWART_AI_MODE_STORAGE_KEY = 'yogurt-ai:canvas-ai-mode'

export function normalizeCowartAiMode(value) {
  return value === true || value === 'on' || value === 'true'
}

export function readCowartAiMode(storage) {
  try {
    const targetStorage = storage === undefined ? globalThis.localStorage : storage
    return normalizeCowartAiMode(targetStorage?.getItem?.(COWART_AI_MODE_STORAGE_KEY))
  } catch (_error) {
    return false
  }
}

export function persistCowartAiMode(enabled, storage) {
  const normalized = Boolean(enabled)
  try {
    const targetStorage = storage === undefined ? globalThis.localStorage : storage
    targetStorage?.setItem?.(COWART_AI_MODE_STORAGE_KEY, normalized ? 'on' : 'off')
  } catch (_error) {
    // Storage can be unavailable in a restricted widget. The in-memory mode still works.
  }
  return normalized
}

export function isCowartAiOnlyTool(toolId) {
  return ['cowart-agent-lasso', 'cowart-annotation', 'ai-image', 'ai-draft', 'ai-slides'].includes(
    String(toolId || '')
  )
}
