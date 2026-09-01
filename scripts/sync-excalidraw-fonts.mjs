import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = path.resolve(
  process.argv[2] || path.join(projectRoot, 'node_modules', '@excalidraw', 'excalidraw')
)
const fontSourceDir = path.join(packageRoot, 'dist', 'prod', 'fonts')
const expectedTargetParent = path.join(projectRoot, 'public')
const assetTargetDir = path.join(expectedTargetParent, 'excalidraw-assets')
const fontTargetDir = path.join(assetTargetDir, 'fonts')

if (path.dirname(assetTargetDir) !== expectedTargetParent) {
  throw new Error(`Refusing to replace unexpected asset directory: ${assetTargetDir}`)
}

const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
if (packageJson.name !== '@excalidraw/excalidraw') {
  throw new Error(`Expected @excalidraw/excalidraw, received ${packageJson.name ?? 'unknown package'}`)
}

await mkdir(expectedTargetParent, { recursive: true })
await rm(assetTargetDir, { recursive: true, force: true })
await mkdir(assetTargetDir, { recursive: true })
await cp(fontSourceDir, fontTargetDir, { recursive: true })
await writeFile(
  path.join(assetTargetDir, 'SOURCE.json'),
  `${JSON.stringify({
    sourcePackage: packageJson.name,
    sourceVersion: packageJson.version,
    sourceRepository: packageJson.repository,
    copiedFrom: 'dist/prod/fonts'
  }, null, 2)}\n`,
  'utf8'
)

console.log(`Synced official Excalidraw fonts from ${packageJson.name}@${packageJson.version}`)
