#!/usr/bin/env node
/**
 * Test double for the Antigravity CLI (`agy --print … --output-format json`).
 * It behaves like the real model through Studio's MCP bridge: reads the attempt's
 * .agents/mcp_config.json, calls get_job_context, fetch_slice for every slice,
 * then submit_analysis (first turn) or submit_review (--conversation turns), and
 * prints agy's JSON envelope. Per-page behaviour comes from FAKE_AGY_PLAN
 * ({ "<page stem>": { box, delayMs, hang, review, providerError } }); every turn
 * is logged to FAKE_AGY_LOG.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const resumed = !!arg('--conversation')
const conv = arg('--conversation') ?? crypto.randomUUID()
const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.studio.env
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = entry => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, conv, resumed, ...entry }) + '\n')
const envelope = extra => process.stdout.write(JSON.stringify({ conversation_id: conv, status: 'SUCCESS', response: 'SUBMITTED', num_turns: 1, denied_actions: [], ...extra }) + '\n')

async function call(tool, a = {}) {
  const response = await fetch(`${cfg.STUDIO_BRIDGE_URL}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.STUDIO_ATTEMPT_TOKEN}`, 'x-studio-client': '1' },
    body: JSON.stringify({ tool, arguments: a, conversationId: conv })
  })
  return response.json()
}
const textOf = r => r?.content?.find(c => c.type === 'text')?.text ?? ''

const context = textOf(await call('get_job_context'))
const stem = /Page "([^"]+)"/.exec(context)?.[1]
const job = /Job ([0-9a-f-]+)\./.exec(context)?.[1]
const sha = /SHA-256 ([0-9a-f]{64})/.exec(context)?.[1]
const size = /Original page: (\d+)×(\d+) px/.exec(context)
const slices = [...context.matchAll(/ {2}(s\d+): (\d+)×(\d+) px, original page y=(\d+)\.\.(\d+)/g)].map(m => ({ id: m[1], y0: Number(m[4]), y1: Number(m[5]) }))
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'))[stem] ?? {}
log({ stem, event: 'start', turn: resumed ? 'review' : 'analysis' })

if (plan.providerError) {
  log({ stem, event: 'end' })
  envelope({ status: 'ERROR', error: plan.providerError })
  process.exit(1)
}

// Metadata (STUDIO METADATA prompts): fetch every requested crop, then one record each through submit_metadata.
// plan.metadata: { badFirst: true } submits an incomplete record first; { skipFetch: true } submits without fetching
// ({ skipFetchResumed: true }: only in resumed turns, i.e. from the second batch on).
const metaPrompt = arg('--print') ?? ''
if (context.includes('Task: Metadata')) {
  // A batch prompt lists the crops "in this order: …."; Studio's follow-up says "Continue the same batch (…)".
  const requested = (/in this order: ([^\n]+?)\.\n/.exec(metaPrompt)?.[1] ?? /Continue the same batch \(([^)]+)\)/.exec(metaPrompt)?.[1] ?? '').split(', ').filter(Boolean)
  // The follow-up doesn't repeat inputRevision: remember it per conversation, as the model would.
  const memory = `${process.env.FAKE_AGY_LOG}.revision-${conv}`
  const revision = /"inputRevision":"([0-9a-f]{64})"/.exec(metaPrompt)?.[1] ?? (fs.existsSync(memory) ? fs.readFileSync(memory, 'utf8') : 'unknown')
  fs.writeFileSync(memory, revision)
  const m = plan.metadata ?? {}
  await sleep(m.delayMs ?? 0)
  if (!m.skipFetch && !(m.skipFetchResumed && resumed)) for (const id of requested) log({ stem, event: 'fetched', id, error: (r => (r.isError ? textOf(r) : null))(await call('fetch_crop', { image_id: id })) })
  const record = name => ({ exportedFilename: name, description: `Artwork of ${name}.`, storyContext: 'The traveller finds a sword.', scriptRefs: ['P0001'], matchType: 'direct', evidence: 'A sword is visible.', reviewReason: '' })
  if (m.badFirst && !resumed) {
    const bad = await call('submit_metadata', { json: JSON.stringify({ schema_version: 'sleeper-cell-metadata/1', inputRevision: revision, crops: requested.map(n => ({ ...record(n), reviewReason: undefined })) }) })
    log({ stem, event: 'submit_metadata', error: bad.isError ? textOf(bad) : null })
  }
  const result = await call('submit_metadata', { json: JSON.stringify({ schema_version: 'sleeper-cell-metadata/1', inputRevision: revision, crops: requested.map(record) }) })
  log({ stem, event: 'submit_metadata', batch: requested, error: result.isError ? textOf(result) : null })
  log({ stem, event: 'end' })
  envelope({})
  process.exit(0)
}

// Timeline (Editor 2.0): plan key "ch<number>-<en|hi>". plan.timeline: { badFirst } (one-shot: an unknown image
// first), { stopAfter: n } (small batches: in the first turn answer n batches, then end it), { silent: true } (answer nothing),
// { delayMs }.
if (context.includes('Task: Editor 2.0 timeline')) {
  const chapterKey = `ch${/Chapter (\d+)/.exec(context)?.[1]}-${/Hindi narration/.test(context) ? 'hi' : 'en'}`
  const t = (JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'))[chapterKey] ?? {}).timeline ?? {}
  log({ stem: chapterKey, event: 'start', turn: resumed ? 'continue' : 'first' })
  await sleep(t.delayMs ?? 0)
  if (t.silent) { log({ stem: chapterKey, event: 'end' }); envelope({}); process.exit(0) }
  if (context.includes('(One-shot)')) {
    const sections = [...context.matchAll(/Section (\d+): audio 00:00\.00–(\d\d:\d\d\.\d\d)/g)].map(m => ({ n: Number(m[1]), end: m[2] }))
    const images = [...new Set([...(arg('--print') ?? '').matchAll(/"exportedFilename":\s*"([^"]+)"/g)].map(m => m[1]))]
    const timeline = image => JSON.stringify({ sections: sections.map(s => ({ section: `Section ${s.n}`, timelines: [{ timeline: `00:00.00 - ${s.end}`, selectedImages: [image] }] })) })
    if (t.badFirst && !resumed) {
      const bad = await call('submit_timeline', { json: timeline('no_such_crop.png') })
      log({ stem: chapterKey, event: 'submit_timeline', error: bad.isError ? textOf(bad) : null })
    }
    const result = await call('submit_timeline', { json: timeline(images[0] ?? 'none.png') })
    log({ stem: chapterKey, event: 'submit_timeline', images, error: result.isError ? textOf(result) : null })
    log({ stem: chapterKey, event: 'end' })
    envelope({})
    process.exit(0)
  }
  // Small batches: answer each batch from its own data (the task prompt: header, instructions, data JSON, template).
  const answer = task => {
    const lines = task.split('\n\n').slice(1).join('\n\n').split('\n')
    const stage = /\((index|route|select|review|repair)\)/.exec(task)?.[1]
    const data = JSON.parse(lines[2])
    if (stage === 'index') return { summary: 'A scene', labels: Object.fromEntries(data.crops.map(c => [c.id, c.description.slice(0, 60)])) }
    if (stage === 'review') return { failed: [], reasons: {} }
    if (stage === 'route') return { routes: Object.fromEntries(data.beats.map(b => [b.id, [data.index[0].id]])), uncertain: [] }
    return { selections: Object.fromEntries(data.beats.map(b => [b.id, [data.crops[0].id]])), uncertain: [] }
  }
  let reply = textOf(await call('get_task'))
  let answered = 0
  while (/^task_id: /.test(reply.replace(/^Accepted\. Next batch:\n\n/, '')) && (t.stopAfter == null || resumed || answered < t.stopAfter)) {
    const task = reply.replace(/^Accepted\. Next batch:\n\n/, '')
    const id = /^task_id: (\S+)/.exec(task)[1]
    const result = await call('submit_task', { task_id: id, json: JSON.stringify(answer(task)) })
    answered++
    log({ stem: chapterKey, event: 'submit_task', id, error: result.isError ? textOf(result) : null })
    reply = textOf(result)
    // Another conversation (the chapter's other language) answered a shared batch first: take the batch Studio hands back.
    if (result.isError && reply.includes('is not the current batch. Answer this one:\n\n')) { reply = reply.split('Answer this one:\n\n')[1]; continue }
    if (result.isError) break
  }
  log({ stem: chapterKey, event: 'end', answered, last: reply.slice(0, 80) })
  envelope({})
  process.exit(0)
}

const corner = (x, y, end) => {
  const s = slices.find(s => (end ? y > s.y0 && y <= s.y1 : y >= s.y0 && y < s.y1))
  return { slice_id: s.id, x, y: y - s.y0 }
}
const box = plan.box
const geometry = { top_left: corner(box.x0, box.y0, false), bottom_right: corner(box.x1, box.y1, true) }

// The four-step flow (Gemini 3.8 Flash): one step per turn, every answer through submit_step.
const prompt = arg('--print') ?? ''
const stepNumber = Number(/STEP (\d) OF 4/.exec(prompt)?.[1] ?? 0)
if (stepNumber) {
  const tools = await (await fetch(`${cfg.STUDIO_BRIDGE_URL}/tools`, { method: 'POST', headers: { authorization: `Bearer ${cfg.STUDIO_ATTEMPT_TOKEN}`, 'x-studio-client': '1' }, body: '{}' })).json()
  const ordered = text => (/in (?:this )?order: ([^\n]+?)\.\n/.exec(text)?.[1] ?? '').split(', ').filter(Boolean)
  let answer
  if (stepNumber === 1) {
    for (const s of slices) await call('fetch_slice', { slice_id: s.id })
    const from = geometry.top_left.slice_id
    const to = geometry.bottom_right.slice_id
    answer = { schema_version: 'clipper-inventory/1.0', job_id: job, shots: [{ shot_id: 'shot-01', subjects: 'solid block', from: { slice_id: from, part: 'top' }, to: { slice_id: to, part: 'bottom' }, notes: '' }], page_has_no_artwork: false }
  } else if (stepNumber === 2) {
    answer = { schema_version: 'clipper-geometry/1.0', job_id: job, coordinate_system: 'slice_local_pixels', candidates: [{ candidate_id: 'candidate-01', shot_ids: ['shot-01'], reason: 'illustrated_shot', ...geometry, visual_evidence: 'solid block', review_flags: [] }], dropped_shots: [] }
  } else if (stepNumber === 3) {
    const ids = ordered(prompt)
    for (const id of ids) log({ stem, event: 'fetched', id, error: (r => (r.isError ? textOf(r) : null))(await call('fetch_step_image', { image_id: id })) })
    answer = { schema_version: 'clipper-crop-inspection/1', job_id: job, inspections: ids.map(id => ({ candidate_id: id, box_problem: null })) }
  } else {
    for (const id of ordered(prompt)) log({ stem, event: 'fetched', id, error: (r => (r.isError ? textOf(r) : null))(await call('fetch_step_image', { image_id: id })) })
    answer = {
      schema_version: 'clipper-review-geometry/1.0', job_id: job, source_sha256: sha, review_revision: Number(/"review_revision"\s*:\s*(\d+)/.exec(prompt)?.[1] ?? 1), coordinate_system: 'slice_local_pixels',
      crops: [{ key: 'candidate-01', reason: 'illustrated_shot', ...geometry, checks_reviewed: [...new Set(prompt.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])] }],
      removed_keys: [], redescribe_keys: [], sweep_done: true, page_has_no_artwork: false, notes: ''
    }
  }
  const result = await call('submit_step', { json: JSON.stringify(answer) })
  log({ stem, event: 'submit_step', step: stepNumber, tools: tools.tools.map(t => t.name), error: result.isError ? textOf(result) : null })
  log({ stem, event: 'end' })
  envelope({})
  process.exit(0)
}

if (!resumed) {
  for (const s of slices) await call('fetch_slice', { slice_id: s.id })
  await sleep(plan.delayMs ?? 0)
  if (plan.hang) await sleep(60_000)
  const analysis = {
    schema_version: 'chatgpt-analysis/1.0', job_id: job, source_sha256: sha, page_stem: stem,
    source_width: Number(size[1]), source_height: Number(size[2]), coordinate_system: 'slice_local_pixels',
    page_inspection_complete: true, page_review_flags: [],
    candidates: [{ candidate_id: 'candidate-01', reason: 'illustrated_shot', ...geometry, visual_evidence: 'solid block', review_flags: [] }]
  }
  const result = await call('submit_analysis', { json: JSON.stringify(analysis) })
  log({ stem, event: 'submit_analysis', error: result.isError ? textOf(result) : null })
} else if (plan.review !== false && !fs.existsSync(`${process.env.FAKE_AGY_PLAN}.no-review-${stem}`)) {
  await sleep(plan.reviewDelayMs ?? 0)
  const review = {
    schema_version: 'clipper-review-geometry/1.0', job_id: job, source_sha256: sha, review_revision: Number(/"review_revision"\s*:\s*(\d+)/.exec(arg('--print') ?? '')?.[1] ?? 1), coordinate_system: 'slice_local_pixels',
    crops: [{ key: 'candidate-01', reason: 'illustrated_shot', ...geometry, checks_reviewed: plan.checks ?? [...new Set((arg('--print') ?? '').match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])] }],
    removed_keys: [], redescribe_keys: [], sweep_done: true, page_has_no_artwork: false, notes: ''
  }
  const result = await call('submit_review', { json: JSON.stringify(review) })
  log({ stem, event: 'submit_review', error: result.isError ? textOf(result) : null })
}
log({ stem, event: 'end' })
envelope({})
