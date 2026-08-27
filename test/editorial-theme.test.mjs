import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the visual atelier desktop shell is wired after the legacy themes', async () => {
  const [mainSource, appSource] = await Promise.all([
    readProjectFile('src/main.jsx'),
    readProjectFile('src/App.jsx')
  ])

  assert.match(mainSource, /@fontsource\/barlow-condensed\/latin-800\.css/)
  assert.match(mainSource, /@fontsource\/ibm-plex-mono\/latin-500\.css/)
  assert.ok(
    mainSource.indexOf("./editorialTheme.css") > mainSource.indexOf("./styles.css"),
    'the editorial compatibility theme must remain after the legacy CSS'
  )
  assert.ok(
    mainSource.indexOf("./atelierTheme.css") > mainSource.indexOf("./editorialTheme.css"),
    'the selected visual atelier theme must remain the final CSS override'
  )
  assert.match(appSource, /<YogurtSideRail/)
  assert.match(appSource, /<YogurtAppChrome/)
  assert.match(appSource, /<CowartCanvasEditorialEmptyState \/>/)
  assert.match(appSource, /atelier-city-hero\.webp/)
  assert.match(appSource, /atelier-branch-flow\.webp/)
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

test('the visual atelier theme keeps messages readable and alternate viewport states usable', async () => {
  const theme = await readProjectFile('src/atelierTheme.css')

  assert.match(theme, /@media \(max-width: 1180px\)/)
  assert.match(theme, /@media \(max-width: 940px\)/)
  assert.match(theme, /@media \(max-width: 720px\)/)
  assert.match(theme, /@media \(max-width: 520px\)/)
  assert.match(theme, /\.cowart-agent-panel\s*\{/)
  assert.match(theme, /\.cowart-agent-panel-launcher\s*\{/)
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(theme, /:focus-visible/)
  assert.doesNotMatch(theme, /line-clamp/i)
})

test('the compact visual atelier keeps one usable canvas column', async () => {
  const theme = await readProjectFile('src/atelierTheme.css')
  const compactTheme = theme.slice(theme.indexOf('@media (max-width: 720px)'))

  assert.match(compactTheme, /\.yogurt-side-rail\s*\{\s*display:\s*none;/s)
  assert.match(compactTheme, /\.cowart-canvas-editorial-empty\s*\{[^}]*grid-template-columns:\s*minmax\(260px, 1fr\)/s)
  assert.match(compactTheme, /\.cowart-agent-panel\s*\{\s*inset:\s*54px 0 0;/s)
})

test('the visual atelier uses optimized bundled raster assets', async () => {
  const assetPaths = [
    '../src/assets/atelier-city-hero.webp',
    '../src/assets/atelier-city-alley.webp',
    '../src/assets/atelier-interior.webp',
    '../src/assets/atelier-branch-flow.webp'
  ]
  const assets = await Promise.all(assetPaths.map((path) => stat(new URL(path, import.meta.url))))
  for (const asset of assets) {
    assert.ok(asset.size > 50_000)
    assert.ok(asset.size < 500_000)
  }
})

test('the desktop shell and public copy advertise only implemented capabilities', async () => {
  const [appSource, railSource, chromeSource, theme, readme, readmeEnglish, plugin] = await Promise.all([
    readProjectFile('src/App.jsx'),
    readProjectFile('src/YogurtSideRail.jsx'),
    readProjectFile('src/YogurtAppChrome.jsx'),
    readProjectFile('src/atelierTheme.css'),
    readProjectFile('README.md'),
    readProjectFile('README.en.md'),
    readProjectFile('.codex-plugin/plugin.json')
  ])

  for (const publicSurface of [appSource, railSource, chromeSource, readme, readmeEnglish, plugin]) {
    assert.doesNotMatch(publicSurface, /TAPD/i)
  }
  assert.match(appSource, /atelier-demo-label/)
  assert.match(appSource, /atelier-constraint-card/)
  assert.doesNotMatch(appSource, /atelier-tapd-card/)
  assert.doesNotMatch(railSource, /LinkSimple|帮助文档即将接入/)
  assert.doesNotMatch(chromeSource, /ShareNetwork|UserPlus|DotsThree|当前协作者|邀请协作者/)
  assert.doesNotMatch(theme, /yogurt-app-share|yogurt-app-collaborators/)
})
