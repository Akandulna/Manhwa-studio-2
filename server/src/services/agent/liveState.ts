/**
 * A few lines about what is running RIGHT NOW (the AntiGravity process on this Mac, script runs on phones, the model in
 * use), read fresh before every step of a turn and put in the agent's prompt. Without it the agent only knew what its
 * last action returned, so a process the user (or Studio itself) started a moment ago looked "not running" to it.
 * Local reads only: Studio's own API and the server's last copy of the phones' receipts (never R2).
 */

import { call, type ToolContext } from './agentTools.js'

export async function liveState(ctx: ToolContext): Promise<string> {
  const lines: string[] = [`Time now: ${new Date().toLocaleString()}`]
  try {
    const cur = await call<{ live: boolean; run: any | null }>(ctx, 'GET', '/antigravity/runs/current')
    if (cur.live && cur.run) {
      const run = cur.run
      const title = (await ctx.prisma.series.findUnique({ where: { id: run.seriesId }, select: { title: true } }))?.title ?? 'a series'
      const kind = run.kind === 'metadata' ? 'Metadata' : run.kind === 'editor' ? 'Timeline' : run.kind === 'narration' ? 'Narration scripts' : 'Image Clipper'
      let jobs = ''
      try {
        const detail = await call<{ jobs: any[] }>(ctx, 'GET', `/antigravity/runs/${run.id}`)
        const by = new Map<string, number>()
        for (const j of detail.jobs ?? []) by.set(j.stage, (by.get(j.stage) ?? 0) + 1)
        jobs = by.size ? ` Jobs: ${[...by].map(([k, n]) => `${n} ${k}`).join(', ')}.` : ''
      } catch { /* the headline is enough */ }
      lines.push(`AntiGravity process on this Mac: ${kind}, "${title}" part ${run.partNumber}, state ${run.control}.${jobs} (A process is RUNNING. Never say it is not running, or that a start failed, while this line says so.)`)
    } else lines.push('AntiGravity process on this Mac: none running.')
  } catch { lines.push('AntiGravity process on this Mac: could not be read.') }
  try {
    const s = await call<Record<string, any>>(ctx, 'GET', '/antigravity/settings')
    if (s.engine === 'codex' || s.engine === 'claude') {
      const e = (await call<any>(ctx, 'GET', `/antigravity/${s.engine}/connection`))?.settings ?? {}
      lines.push(`AI engine for new AntiGravity jobs: ${s.engine === 'codex' ? 'ChatGPT (Codex)' : 'Claude'}, model ${e.modelLabel ?? e.model ?? 'none chosen'}${e.effort ? `, reasoning ${e.effort}` : ''}.`)
    } else lines.push(`AI engine for new AntiGravity jobs: Antigravity, model ${s.modelLabel ?? s.model ?? 'none chosen'}.`)
  } catch { /* optional */ }
  try {
    const o = await call<any>(ctx, 'GET', '/r2/phone/overview')
    const runs = (o.runs ?? []).filter((r: any) => r.kind === 'narration')
    lines.push(runs.length
      ? `Phone script runs: ${runs.map((r: any) => `${r.phone} on "${r.series}" ${r.done}/${r.total}${r.paused ? ' (paused)' : ''}`).join('; ')} (last receipt).`
      : 'Phone script runs: none in the last receipt.')
  } catch { /* no relay */ }
  try {
    const mine = ctx.chatId ? (await ctx.store.watches()).filter(w => w.chatId === ctx.chatId) : []
    const said = mine.map(w => w.kind === 'mac_next' ? `start "${w.title}" part ${w.part} on this Mac when "${w.afterTitle}" part ${w.afterPart} ends${w.requireComplete ? ' with all its scripts' : ''}`
      : w.kind === 'mac_switch' ? `switch settings and continue "${w.title}" part ${w.part}`
      : w.kind === 'phone' ? `report ${w.phoneName}'s script run on "${w.title}"`
      : w.kind === 'crop' ? `report Crop Sections of "${w.title}"`
      : `report the ${w.kind === 'clipper' ? 'Image Clipper' : 'Narration'} run of "${w.title}" part ${w.part}`)
    lines.push(said.length ? `Studio is watching for this chat (it will post here by itself): ${said.join('; ')}.` : 'Studio is watching for this chat: nothing (it will NOT post here by itself; do not promise it will).')
  } catch { /* optional */ }
  return lines.join('\n')
}
