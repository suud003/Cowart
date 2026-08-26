import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the editorial desktop shell is wired after the legacy styles', async () => {
  const [mainSource, appSource] = await Promise.all([
    readProjectFile('src/main.jsx'),
    readProjectFile('src/App.jsx')
  ])

  assert.match(mainSource, /@fontsource\/barlow-condensed\/latin-800\.css/)
  assert.match(mainSource, /@fontsource\/ibm-plex-mono\/latin-500\.css/)
  assert.ok(
    mainSource.indexOf("./editorialTheme.css") > mainSource.indexOf("./styles.css"),
    'the visual theme must remain the final CSS override'
  )
  assert.match(appSource, /<YogurtAppChrome/)
  assert.match(appSource, /<CowartCanvasEditorialEmptyState \/>/)
  assert.match(appSource, /licenseKey=\{TLDRAW_LICENSE_KEY\}/)
  assert.match(appSource, /data-agent-open=\{isAgentPanelOpen \? 'true' : 'false'\}/)
  assert.match(appSource, /inert=\{isModalAgentPanel \? true : undefined\}/)
  assert.match(appSource, /isModal=\{isModalAgentPanel\}/)
  assert.match(appSource, /onAttentionChange=\{setAgentPanelAttention\}/)
})

test('the integrated Agent toggle preserves explicit state and attention semantics', async () => {
  const chromeSource = await readProjectFile('src/YogurtAppChrome.jsx')

  assert.match(chromeSource, /aria-pressed=\{isAgentPanelOpen\}/)
  assert.match(chromeSource, /aria-controls="yogurt-codex-agent-panel"/)
  assert.match(chromeSource, /aria-expanded=\{isAgentPanelOpen\}/)
  assert.match(chromeSource, /data-attention=\{agentAttention\?\.kind \|\| 'none'\}/)
  assert.match(chromeSource, /onAgentPanelOpenChange\(!isAgentPanelOpen\)/)
  assert.match(chromeSource, /const accessibleToggleLabel = attentionAnnouncement/)
  assert.doesNotMatch(chromeSource, /agentAttention\?\.accessibleLabel \|\| toggleLabel/)
})

test('the editorial theme keeps messages readable and alternate viewport states usable', async () => {
  const theme = await readProjectFile('src/editorialTheme.css')

  assert.match(theme, /@media \(max-width: 1260px\)/)
  assert.match(theme, /@media \(max-width: 940px\)/)
  assert.match(theme, /@media \(max-width: 520px\)/)
  assert.match(theme, /\.cowart-workbench\[data-agent-open="true"\]/)
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(theme, /:focus-visible/)
  assert.doesNotMatch(theme, /line-clamp/i)
})

test('the compact empty state overrides the medium-width positioning with equal specificity', async () => {
  const theme = await readProjectFile('src/editorialTheme.css')
  const compactTheme = theme.slice(theme.indexOf('@media (max-width: 720px)'))

  assert.match(
    compactTheme,
    /\.cowart-workbench\[data-agent-open="false"\] \.cowart-canvas-editorial-empty\s*\{[^}]*right:\s*36px;[^}]*left:\s*48px;[^}]*width:\s*auto;/s
  )
})

test('the editorial texture is a real bundled raster asset', async () => {
  const asset = await stat(new URL('../src/assets/yogurt-editorial-field.webp', import.meta.url))
  assert.ok(asset.size > 50_000)
  assert.ok(asset.size < 500_000)
})
