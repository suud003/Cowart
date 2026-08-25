import assert from 'node:assert/strict'
import test from 'node:test'

import {
  YOGURT_DESKTOP_CONTENT_SECURITY_POLICY,
  desktopCspPlugin,
  injectYogurtDesktopCsp
} from '../desktop/content-security-policy.mjs'
import {
  COWART_TLDRAW_FONT_FILES,
  buildCowartTldrawFontUrls,
  isYogurtDesktopRenderer
} from '../src/cowartTldrawAssets.js'
import { normalizeBuildAssetPath } from '../mcp/lib/cowart-static-widget.mjs'

test('desktop renderer uses every bundled tldraw font URL', () => {
  const sources = Object.fromEntries(
    Object.values(COWART_TLDRAW_FONT_FILES).map((fileName) => [
      `../node_modules/@tldraw/assets/fonts/${fileName}`,
      `data:font/woff2;base64,${fileName}`
    ])
  )

  const fonts = buildCowartTldrawFontUrls(sources)

  assert.equal(Object.keys(fonts).length, 16)
  assert.equal(fonts.tldraw_sans, 'data:font/woff2;base64,IBMPlexSans-Medium.woff2')
  assert.equal(fonts.tldraw_draw_bold, 'data:font/woff2;base64,Shantell_Sans-Informal_Bold.woff2')
  assert.equal(isYogurtDesktopRenderer({ yogurtAgent: {} }), true)
  assert.equal(isYogurtDesktopRenderer({}), false)
})

test('desktop font URL construction fails closed when a bundled font is missing', () => {
  assert.throws(
    () => buildCowartTldrawFontUrls({}),
    /Missing bundled tldraw font: IBMPlexMono-Medium\.woff2/
  )
})

test('production desktop HTML receives a restrictive CSP without changing widget or dev HTML', () => {
  const html = '<!doctype html><html><head><title>Yogurt AI</title></head><body></body></html>'
  const secured = injectYogurtDesktopCsp(html)

  assert.match(secured, /http-equiv="Content-Security-Policy"/)
  assert.equal(injectYogurtDesktopCsp(secured), secured)
  assert.doesNotMatch(YOGURT_DESKTOP_CONTENT_SECURITY_POLICY, /unsafe-eval/)
  assert.match(YOGURT_DESKTOP_CONTENT_SECURITY_POLICY, /script-src 'self'(?:;|$)/)
  assert.doesNotMatch(YOGURT_DESKTOP_CONTENT_SECURITY_POLICY, /googletagmanager/)
  assert.match(YOGURT_DESKTOP_CONTENT_SECURITY_POLICY, /font-src 'self' data:/)
  assert.match(YOGURT_DESKTOP_CONTENT_SECURITY_POLICY, /connect-src 'self' data: blob: https:/)

  assert.equal(desktopCspPlugin({ widgetBuild: true }).transformIndexHtml(html, {}), html)
  assert.equal(desktopCspPlugin().transformIndexHtml(html, { server: {} }), html)
  assert.match(
    desktopCspPlugin().transformIndexHtml(html, {}),
    /http-equiv="Content-Security-Policy"/
  )
})

test('static widget inliner consumes relative Vite asset paths without allowing traversal', () => {
  assert.equal(normalizeBuildAssetPath('./assets/index.js'), 'assets/index.js')
  assert.equal(normalizeBuildAssetPath('/assets/style.css'), 'assets/style.css')
  assert.throws(() => normalizeBuildAssetPath('../outside.js'), /Invalid Yogurt AI widget build asset path/)
  assert.throws(() => normalizeBuildAssetPath('assets\\outside.js'), /Invalid Yogurt AI widget build asset path/)
})
