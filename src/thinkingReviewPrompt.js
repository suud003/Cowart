export function buildThinkingReviewPrompt({
  selectedIds,
  includedIds,
  screenshotAsset,
  userInstruction,
  width,
  height
}) {
  return [
    'Use $cowart-semantic-diagram to carry out this scoped native editable-diagram request.',
    '',
    'User request:',
    userInstruction.trim(),
    '',
    'Scope and visual evidence:',
    `- Exact target shape IDs: ${selectedIds.join(', ')}`,
    '- A hand-drawn enclosure in the screenshot, when present, defines the same editable region. Treat that enclosure and other marks as instructions, not content to reproduce.',
    '- The screenshot is authoritative for circles, arrows, strike-throughs, grouping marks, and handwritten or typed annotations.',
    `- Screenshot includes ${includedIds.length} shape(s) and is ${Math.round(width)}x${Math.round(height)} pixels.`,
    ...(screenshotAsset?.assetPath
      ? [
          `- Annotation screenshot local path: ${screenshotAsset.assetPath}`,
          '- Read that local image if the host message does not expose the attached image.'
        ]
      : []),
    '',
    'Required workflow:',
    '1. Read the selected Yogurt AI context and preserve links to source material.',
    '2. Briefly interpret the request and visible marks; ask only when an ambiguity would materially change the result.',
    '3. Preserve stable semantic IDs when revising an existing generated diagram. Preview one typed native operation batch against the latest revision.',
    '4. Apply that same batch only to the selected region. Never rewrite, move, or delete unrelated page content.',
    '5. An explicit request to delete selected content is authorization for that selected content only; never infer deletion.',
    '6. Explain what changed, the evidence used, and provide the operation ID for undo.',
    'Use only native editable cards, semantic zones, text, and bound relations. Keep the Excalidraw-style draw stroke and font, and never fall back to image, HTML, SVG, Slides, Auto Compose, or PRD output.'
  ].join('\n')
}
