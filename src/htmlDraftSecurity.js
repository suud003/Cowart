export const COWART_INTERACTIVE_HTML_SANDBOX =
  'allow-forms allow-popups allow-same-origin allow-scripts'
export const COWART_SEMANTIC_DIAGRAM_SANDBOX = 'allow-same-origin'

export function getCowartHtmlDraftSandbox(meta) {
  return meta?.cowartSemanticDiagram && typeof meta.cowartSemanticDiagram === 'object'
    ? COWART_SEMANTIC_DIAGRAM_SANDBOX
    : COWART_INTERACTIVE_HTML_SANDBOX
}
