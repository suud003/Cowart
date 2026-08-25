export const YOGURT_DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https:",
  "frame-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export function injectYogurtDesktopCsp(html) {
  if (typeof html !== 'string') throw new TypeError('Desktop HTML must be a string.')
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html

  const meta = `<meta http-equiv="Content-Security-Policy" content="${YOGURT_DESKTOP_CONTENT_SECURITY_POLICY}" />`
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    ${meta}`)
}

export function desktopCspPlugin({ widgetBuild = false } = {}) {
  return {
    name: 'yogurt-desktop-content-security-policy',
    transformIndexHtml(html, context) {
      if (widgetBuild || context?.server) return html
      return injectYogurtDesktopCsp(html)
    }
  }
}
