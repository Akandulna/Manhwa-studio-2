// Bundle the same pure planner for Sleeper-Cell's offline, isolated WebView.
// Usage: node scripts/build-editor-workflow.mjs /path/to/app/src/main/assets/editor-workflow.js
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const outfile = process.argv[2]
if (!outfile) throw new Error('Supply the Android asset output path')
await build({ entryPoints: [fileURLToPath(new URL('../src/services/editorWorkflow.ts', import.meta.url))], outfile,
  bundle: true, format: 'iife', globalName: 'EditorWorkflowEngine', platform: 'browser', target: 'es2020', minify: true })
