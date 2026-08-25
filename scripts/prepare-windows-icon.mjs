import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(rootDir, 'public', 'cowart-logo.svg')
const licenseSourcePath = path.join(rootDir, 'licenses', 'TLDRAW-LICENSE.md')
const outputDir = path.join(rootDir, 'packaging')
const outputPath = path.join(outputDir, 'yogurt-ai-icon.png')
const licenseOutputPath = path.join(outputDir, 'TLDRAW-LICENSE.txt')

await mkdir(outputDir, { recursive: true })
await sharp(sourcePath, { density: 768 })
  .resize(512, 512, { fit: 'contain' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(outputPath)
await copyFile(licenseSourcePath, licenseOutputPath)

console.log(`Prepared Windows application icon: ${outputPath}`)
console.log(`Prepared verbatim tldraw installer license: ${licenseOutputPath}`)
