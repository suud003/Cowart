export const COWART_TLDRAW_FONT_FILES = Object.freeze({
  tldraw_mono: 'IBMPlexMono-Medium.woff2',
  tldraw_mono_italic: 'IBMPlexMono-MediumItalic.woff2',
  tldraw_mono_bold: 'IBMPlexMono-Bold.woff2',
  tldraw_mono_italic_bold: 'IBMPlexMono-BoldItalic.woff2',
  tldraw_serif: 'IBMPlexSerif-Medium.woff2',
  tldraw_serif_italic: 'IBMPlexSerif-MediumItalic.woff2',
  tldraw_serif_bold: 'IBMPlexSerif-Bold.woff2',
  tldraw_serif_italic_bold: 'IBMPlexSerif-BoldItalic.woff2',
  tldraw_sans: 'IBMPlexSans-Medium.woff2',
  tldraw_sans_italic: 'IBMPlexSans-MediumItalic.woff2',
  tldraw_sans_bold: 'IBMPlexSans-Bold.woff2',
  tldraw_sans_italic_bold: 'IBMPlexSans-BoldItalic.woff2',
  tldraw_draw: 'Shantell_Sans-Informal_Regular.woff2',
  tldraw_draw_italic: 'Shantell_Sans-Informal_Regular_Italic.woff2',
  tldraw_draw_bold: 'Shantell_Sans-Informal_Bold.woff2',
  tldraw_draw_italic_bold: 'Shantell_Sans-Informal_Bold_Italic.woff2'
})

export function isYogurtDesktopRenderer(windowObject = globalThis.window) {
  return Boolean(windowObject?.yogurtAgent)
}

export function buildCowartTldrawFontUrls(fontSources) {
  const sourcesByFileName = new Map(
    Object.entries(fontSources || {}).map(([sourcePath, sourceUrl]) => [
      sourcePath.split('/').pop(),
      sourceUrl
    ])
  )
  const fonts = {}

  for (const [fontKey, fileName] of Object.entries(COWART_TLDRAW_FONT_FILES)) {
    const sourceUrl = sourcesByFileName.get(fileName)
    if (typeof sourceUrl !== 'string' || !sourceUrl) {
      throw new Error(`Missing bundled tldraw font: ${fileName}`)
    }
    fonts[fontKey] = sourceUrl
  }

  return fonts
}
