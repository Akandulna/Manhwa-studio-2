// Bakes this repo's absolute path into the packaged app, which runs the server
// from here rather than bundling it. Re-run `npm run app` if the repo moves.
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
fs.writeFileSync(
  path.join(__dirname, '..', 'app-config.json'),
  JSON.stringify({ repoRoot }, null, 2) + '\n'
)
console.log(`app-config.json → ${repoRoot}`)
