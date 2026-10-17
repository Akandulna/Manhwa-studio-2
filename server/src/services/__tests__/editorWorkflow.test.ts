import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { acceptWorkflowReply, buildEditorWorkflow, MAX_PROMPT_CHARS, nextWorkflowTask, validateWorkflowReply, validateWorkflowTimeline, WorkflowReplyError, type EditorWorkflow, type WorkflowState, type WorkflowTask } from '../editorWorkflow.js'
import { workflowHash } from '../workflowHash.js'
import { build } from 'esbuild'
import vm from 'node:vm'

function fixture(count = 24, description = 'A pink-haired woman summons a purple spirit beside a brown-haired man.') {
  const images = Array.from({ length: count }, (_, i) => `page_${String(i + 1).padStart(3, '0')}.png`)
  const metadata = JSON.stringify({ crops: images.map(exportedFilename => ({ exportedFilename, description })) })
  const timeline = '## Section 1\n00:00.00 - 00:03.50: "अजिन अपना समन बुलाती है।"\n00:03.50 - 00:07.00: "He reacts."\n\n## Section 2\n00:00.00 - 00:04.50: "She walks away."'
  return { timeline, metadata, images, input: buildEditorWorkflow(timeline, metadata, images) }
}
function replyFor(task: WorkflowTask) {
  if (task.stage === 'index') return { summary: 'Pink-haired woman summons purple spirit; brown-haired man reacts.', labels: Object.fromEntries(task.candidates.map(id => [id, 'Woman summons spirit, man reacts.'])) }
  if (task.stage === 'review') return { failed: [], reasons: {} }
  return { [task.stage === 'route' ? 'routes' : 'selections']: Object.fromEntries(task.beats.map(id => [id, task.candidates.slice(0, 1)])), uncertain: [] }
}
function complete(input: EditorWorkflow, initial: WorkflowState = { replies: {} }, change?: (task: WorkflowTask) => unknown) {
  let state = initial, turns = 0, maxChars = 0
  while (turns++ < 2000) {
    const view = nextWorkflowTask(input, state)
    if (!view.task) return { view, state, maxChars }
    maxChars = Math.max(maxChars, view.task.prompt.length)
    const value = change?.(view.task) ?? replyFor(view.task)
    state = acceptWorkflowReply(input, state, view.task.id, view.task.fingerprint, JSON.stringify(value))
  }
  throw new Error('Workflow did not finish')
}

describe('staged timeline planning', () => {
  it('runs the bundled offline phone planner with identical prompts, fingerprints and output', async () => {
    const bundle = await build({ entryPoints: ['src/services/editorWorkflow.ts'], bundle: true, format: 'iife', globalName: 'EditorWorkflowEngine', platform: 'browser', target: 'es2020', write: false })
    const context = vm.createContext({ TextEncoder })
    vm.runInContext(bundle.outputFiles[0].text, context)
    const engine = context.EditorWorkflowEngine as { nextWorkflowTask: typeof nextWorkflowTask; acceptWorkflowReply: typeof acceptWorkflowReply }
    const { input } = fixture()
    let state: WorkflowState = { replies: {} }
    for (let i = 0; i < 100; i++) {
      const desktop = nextWorkflowTask(input, state)
      const phone = engine.nextWorkflowTask(input, state)
      expect(JSON.stringify(phone)).toBe(JSON.stringify(desktop))
      if (!desktop.task) break
      const t = desktop.task, reply = JSON.stringify(replyFor(t))
      expect(JSON.stringify(engine.acceptWorkflowReply(input, state, t.id, t.fingerprint, reply)))
        .toBe(JSON.stringify(acceptWorkflowReply(input, state, t.id, t.fingerprint, reply)))
      state = engine.acceptWorkflowReply(input, state, t.id, t.fingerprint, reply)
    }
    expect(engine.nextWorkflowTask(input, state).json).toBeTruthy()
  })
  it.each(['', 'abc', 'हिंग्लिश 🌠', 'a'.repeat(1000)])('uses the same SHA-256 on desktop and the offline phone engine: %s', text => {
    expect(workflowHash(text)).toBe(createHash('sha256').update(text).digest('hex'))
  })
  it('preserves exact times and filenames across independently reviewed small selections', () => {
    const { input, images } = fixture()
    const { view, maxChars } = complete(input)
    const json = JSON.parse(view.json!)
    expect(json.sections.map((s: any) => s.section)).toEqual(['Section 1', 'Section 2'])
    expect(json.sections.flatMap((s: any) => s.timelines.map((t: any) => t.timeline))).toEqual(input.beats.map(b => b.range))
    expect(json.sections[0].timelines[0].selectedImages).toEqual([images[0]])
    expect(view.warnings.length).toBeGreaterThan(0)
    expect(maxChars).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
  })
  it('requires exact coverage and rejects invented IDs, filenames and extra timing fields', () => {
    const { input } = fixture()
    const done = complete(input)
    const select = nextWorkflowTask(input, { replies: Object.fromEntries(Object.entries(done.state.replies).filter(([id]) => !id.startsWith('select-') && !id.startsWith('review-'))) }).task!
    expect(select.stage).toBe('select')
    expect(() => validateWorkflowReply(select, { selections: {}, uncertain: [] })).toThrow('exactly')
    expect(() => validateWorkflowReply(select, { selections: Object.fromEntries(select.beats.map(id => [id, ['C9999']])), uncertain: [] })).toThrow('IDs')
    expect(() => validateWorkflowReply(select, { ...replyFor(select), sections: [] })).toThrow('exactly')
    expect(() => validateWorkflowReply(select, { ...replyFor(select), uncertain: ['unknown'] })).toThrow('IDs')
  })
  it('reuses visual checkpoints across languages but invalidates matching when alignment changes', () => {
    const f = fixture(), done = complete(f.input)
    const changed = buildEditorWorkflow(f.timeline.replace('He reacts.', 'He leaves.'), f.metadata, f.images)
    expect(nextWorkflowTask(changed, done.state).task?.stage).toBe('route')
    const metadataChanged = buildEditorWorkflow(f.timeline, f.metadata.replaceAll('purple', 'blue'), f.images)
    expect(nextWorkflowTask(metadataChanged, done.state).task?.stage).toBe('index')
    const resumed = complete(f.input, JSON.parse(JSON.stringify(done.state)))
    expect(resumed.view.json).toBe(done.view.json)
  })
  it('rejects stale replies without altering checkpoints', () => {
    const { input } = fixture(), state = { replies: {} }, task = nextWorkflowTask(input, state).task!
    expect(() => acceptWorkflowReply(input, state, task.id, 'old', JSON.stringify(replyFor(task)))).toThrow('stale')
    expect(state.replies).toEqual({})
  })
  it('gives routing a complete response template and names missing beats in a correction prompt', () => {
    const { input } = fixture()
    const done = complete(input)
    const state = { replies: Object.fromEntries(Object.entries(done.state.replies).filter(([id]) => id.startsWith('V'))) }
    const task = nextWorkflowTask(input, state).task!
    expect(task.stage).toBe('route')
    const template = JSON.parse(task.prompt.split('\n').pop()!)
    expect(Object.keys(template.routes)).toEqual(task.beats)
    const partial = { routes: { [task.beats[0]]: [task.candidates[0]] }, uncertain: [] }
    try {
      acceptWorkflowReply(input, state, task.id, task.fingerprint, JSON.stringify(partial))
      throw new Error('Expected validation to fail')
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowReplyError)
      expect((e as WorkflowReplyError).message).toContain(`Missing: ${task.beats.slice(1).join(', ')}`)
      expect((e as WorkflowReplyError).repairPrompt).toContain('The previous response was rejected')
      expect((e as WorkflowReplyError).repairPrompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
    }
  })
  it('accepts a single JSON response inside normal AI prose/fences without rewriting values', () => {
    const { input } = fixture(), state = { replies: {} }, task = nextWorkflowTask(input, state).task!
    const value = replyFor(task)
    const prose = `Here is the requested response:\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n\nReady for the next batch.`
    expect(acceptWorkflowReply(input, state, task.id, task.fingerprint, prose).replies[task.id].value).toEqual(value)
    expect(() => acceptWorkflowReply(input, state, task.id, task.fingerprint, `${JSON.stringify(value)}\n${JSON.stringify(value)}`)).toThrow('multiple JSON objects')
    expect(() => acceptWorkflowReply(input, state, task.id, task.fingerprint, '{"summary":')).toThrow('not valid JSON')
  })
  it('repairs only the failed beat then independently reviews the repaired selection', () => {
    const { input } = fixture()
    const stages: string[] = []
    const { view } = complete(input, undefined, task => {
      stages.push(task.id)
      if (task.id.startsWith('review-')) return { failed: [task.beats[0]], reasons: { [task.beats[0]]: 'Wrong action' } }
      if (task.stage === 'repair') expect(task.beats).toHaveLength(1)
      return replyFor(task)
    })
    expect(view.json).toBeTruthy()
    expect(stages.some(s => s.startsWith('repair-'))).toBe(true)
    expect(stages.some(s => s.startsWith('verify-'))).toBe(true)
  })
  it('never returns a complete timeline if semantic review keeps failing', () => {
    const { input } = fixture()
    expect(() => complete(input, undefined, task => task.stage === 'review'
      ? { failed: task.beats, reasons: Object.fromEntries(task.beats.map(id => [id, 'No visual evidence'])) } : replyFor(task))).toThrow('Semantic review still cannot resolve')
  })
  it('splits long descriptions and narration into bounded prompts, including review and repair', () => {
    const f = fixture(40, 'A spirit appears. '.repeat(65))
    const input = buildEditorWorkflow(f.timeline.replaceAll('He reacts.', 'He reacts. '.repeat(100)), f.metadata, f.images)
    const { maxChars } = complete(input)
    expect(maxChars).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
  })
  it('routes large chapters in multiple bounded index windows then compares nominations', () => {
    const { input } = fixture(160)
    let routeTasks = 0
    const { maxChars } = complete(input, undefined, task => {
      if (task.stage === 'route') { routeTasks++; return { routes: Object.fromEntries(task.beats.map(id => [id, task.candidates.slice(0, 2)])), uncertain: [] } }
      return replyFor(task)
    })
    expect(routeTasks).toBeGreaterThan(2)
    expect(maxChars).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
  })
  it('fails early on malformed alignment, stale crops or incomplete metadata', () => {
    const f = fixture()
    expect(() => buildEditorWorkflow(f.timeline.replace('00:03.50 - 00:07.00', '00:02.00 - 00:07.00'), f.metadata, f.images)).toThrow('overlap')
    expect(() => buildEditorWorkflow(f.timeline, f.metadata, [])).toThrow('missing from crops3')
    expect(() => buildEditorWorkflow(f.timeline, '{"crops": [', f.images)).toThrow('incomplete')
  })
  it('requires alignment to cover every audio section and its duration', () => {
    const f = fixture()
    expect(() => buildEditorWorkflow(f.timeline, f.metadata, f.images, null, [{ number: 1, durationSec: 7 }])).toThrow('exactly the audio sections')
    expect(() => buildEditorWorkflow(f.timeline, f.metadata, f.images, null, [{ number: 1, durationSec: 7 }, { number: 2, durationSec: 9 }])).toThrow('audio duration')
  })
  it('rejects a phone result that changed a timestamp, lost a beat or invented a crop', () => {
    const { input } = fixture(), { view } = complete(input)
    expect(() => validateWorkflowTimeline(input, view.json!)).not.toThrow()
    expect(() => validateWorkflowTimeline(input, view.json!.replace('00:03.50', '00:03.51'))).toThrow('timestamp')
    const missing = JSON.parse(view.json!); missing.sections[0].timelines.pop()
    expect(() => validateWorkflowTimeline(input, JSON.stringify(missing))).toThrow('every beat')
    expect(() => validateWorkflowTimeline(input, view.json!.replaceAll('page_001.png', 'unknown.png'))).toThrow('crop')
  })
})
