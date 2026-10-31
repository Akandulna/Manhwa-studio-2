import fs from 'fs/promises'
import path from 'path'

/**
 * Writes the given values into the server's .env and process.env, so they
 * take effect immediately and survive a restart. Existing lines are replaced
 * in place; new keys are appended. Values are single-line; anything with a
 * newline is refused.
 */
export async function writeEnvVars(vars: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(vars)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} cannot contain a line break`)
  }
  if (Object.keys(vars).length === 0) return

  const envPath = path.join(process.cwd(), '.env')
  let lines: string[] = []
  try {
    lines = (await fs.readFile(envPath, 'utf-8')).split('\n')
  } catch {
    // No .env yet — it is created below.
  }
  const pending = new Map(Object.entries(vars))
  lines = lines.map(line => {
    const key = line.split('=', 1)[0].trim()
    if (!pending.has(key)) return line
    const value = pending.get(key)!
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) lines.push(`${key}=${value}`)
  await fs.writeFile(envPath, lines.join('\n'), 'utf-8')

  for (const [key, value] of Object.entries(vars)) process.env[key] = value
}
