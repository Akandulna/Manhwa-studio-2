// Copies the built app into /Applications and ad-hoc signs it (Apple silicon
// refuses to run unsigned code; an ad-hoc signature is enough on this Mac).
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const APP = 'Manhwa Studio.app'
const distDir = path.join(__dirname, '..', 'dist')
const built = fs.readdirSync(distDir)
  .map((d) => path.join(distDir, d, APP))
  .find((p) => fs.existsSync(p))
if (!built) throw new Error(`No ${APP} under desktop/dist — run \`npm run pack\` first.`)

const target = path.join('/Applications', APP)
fs.rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [built, target], { stdio: 'inherit' })
execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' })
console.log(`Installed ${target}`)
