import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
const client = fileURLToPath(new URL('../client',import.meta.url))
export default defineConfig({
  resolve: { alias: { '@':`${client}/src`,react:`${client}/node_modules/react`,'react-dom':`${client}/node_modules/react-dom`,'react-router-dom':`${client}/node_modules/react-router-dom` } },
  esbuild: { jsx:'automatic' }
})
