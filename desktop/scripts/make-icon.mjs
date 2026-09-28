// Renders build/icon.svg into build/icon.icns (sharp comes from server/).
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.join(here, '..', 'build')
const sharp = createRequire(path.join(here, '..', '..', 'server', 'package.json'))('sharp')

const svg = fs.readFileSync(path.join(buildDir, 'icon.svg'))
const iconset = path.join(buildDir, 'icon.iconset')
fs.rmSync(iconset, { recursive: true, force: true })
fs.mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    await sharp(svg, { density: 72 * (px / 1024) * 4 }).resize(px, px).png().toFile(path.join(iconset, name))
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')])
fs.rmSync(iconset, { recursive: true, force: true })
console.log('build/icon.icns written')
