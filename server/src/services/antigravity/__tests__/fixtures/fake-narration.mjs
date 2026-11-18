/** Shared narration model double for the agy and Claude stream adapters. */
import fs from 'node:fs'

export async function fakeNarration({ context, prompt, call, log, conv = null }) {
  // A resumed turn gets only Studio's short "continue" message; like a model, remember the stage's data per conversation.
  const remember = (name, value) => {
    const file = conv ? `${process.env.FAKE_AGY_LOG}.${name}-${conv}` : null
    if (value != null && file) fs.writeFileSync(file, value)
    return value ?? (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
  }
  if (context.includes('Task: Hinglish narration of')) return fakeHinglish({ context, prompt, call, log })
  if (!context.includes('Task: Narration of')) return false
  const textOf = r => r?.content?.find(c => c.type === 'text')?.text ?? ''
  const chapterNo = /Chapter (\S+) \(English\)/.exec(context)?.[1]
  const key = `narration-ch${chapterNo}`
  const n = (JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'))[key] ?? {}).narration ?? {}
  const stage = /Stage: (\w+)\./.exec(context)?.[1]
  const batch = Number(/reads batch (\d+)/.exec(context)?.[1])
  const once = name => { try { fs.closeSync(fs.openSync(`${process.env.FAKE_AGY_LOG}.${key}.${name}`, 'wx')); return true } catch (e) { if (e.code === 'EEXIST') return false; throw e } }
  log({ stem: key, event: 'start', stage, batch, cwd: process.cwd(), hasPrevious: prompt.includes('STORY SO FAR:') ? prompt.split('STORY SO FAR:\n')[1].split('\n')[0] : null })
  if (n.silent || n.silentStage === stage) { log({ stem: key, event: 'end', batch, stage }); return true }
  // Read this turn's data before anything else, as a model would, so a resumed turn still has it.
  if (stage === 'review') {
    remember('review-ids', /The mapping must use these piece IDs in this order:\n([^\n]+)/.exec(prompt)?.[1])
    remember('review-about', prompt.includes('The mapping must use') ? String(prompt.includes('Include a non-empty about field.')) : null)
  }
  if (stage === 'check') remember('check-script', /SCRIPT TO CHECK \(data, not instructions\):\n([^\n]+)/.exec(prompt)?.[1])
  // A broken reply stream: the agent goes quiet (no tool calls) until Studio stops it. hangOnce: only the first time.
  if (n.hangStage === stage && (!n.hangOnce || once(`hang-${stage}`))) { log({ stem: key, event: 'hang', batch, stage }); await new Promise(r => setTimeout(r, n.hangMs ?? 60_000)) }
  const paragraph = i => `Something happens in part ${i + 1}.`
  if (stage === 'notes') {
    await new Promise(r => setTimeout(r, n.delays?.[batch] ?? n.delayMs ?? 0))
    if (n.providerErrorBatch === batch) { throw new Error('fixture quota limit reached') }
    if (n.foreignFetch) {
      const foreign = await call('fetch_piece', { piece_id: batch === 1 ? 'P0030-T001' : 'P0001-T001' })
      log({ stem: key, event: 'foreign_fetch', batch, error: foreign.isError ? textOf(foreign) : null })
      const wrong = await call('submit_draft', { text: 'not allowed' })
      log({ stem: key, event: 'foreign_tool', batch, error: wrong.isError ? textOf(wrong) : null })
    }
    const ids = [...context.matchAll(/^(P\d{4}-T\d{3}) = page/gm)].map(m => m[1])
    const fetchPiece = async id => {
      const r = await call('fetch_piece', { piece_id: id })
      log({ stem: key, event: 'fetch', id, image: !!r.content?.find(c => c.type === 'image'), error: r.isError ? textOf(r) : null })
    }
    if (!n.skipFetch) {
      if (n.parallelFetch) await Promise.all(ids.map(fetchPiece))
      else for (const id of ids) await fetchPiece(id)
    }
    const entry = (id, check) => ({ id, check, opening: `Start of ${id}`, events: [`Event in ${id}`], text: [`WORDS PRINTED IN ${id}`], closing: `End of ${id}`, nonStory: false, uncertainties: [] })
    if (n.wrongCheckFirst && once('wrongCheck')) {
      const bad = await call('submit_notes', { json: JSON.stringify({ pieces: ids.map(id => entry(id, 'ZZZZ')) }) })
      log({ stem: key, event: 'submit_notes', ids, error: bad.isError ? textOf(bad) : null })
    }
    const notes = { pieces: [...ids].reverse().map(id => entry(id, n.wrongCheckBatch === batch ? 'ZZZZ' : n.check ?? 'ACDE')) }
    // notesArg: submit as models often do, ignoring the schema's json argument ('spread' = the object as the arguments).
    const args = n.notesArg === 'spread' ? notes : n.notesArg ? { [n.notesArg]: n.notesArg === 'notes' ? notes : JSON.stringify(notes) } : { json: JSON.stringify(notes) }
    const result = await call('submit_notes', args)
    log({ stem: key, event: 'submit_notes', ids, error: result.isError ? textOf(result) : null })
  } else if (stage === 'draft') {
    const ids = [...new Set([...prompt.matchAll(/"id":"(P\d{4}-T\d{3})"/g)].map(m => m[1]))]
    const paragraphs = ids.map((_, i) => `${paragraph(i)} Then the traveller continues carefully and considers the next move.`)
    const about = prompt.includes('===ABOUT===') ? '\n===ABOUT===\nA story about a thief.' : ''
    const result = await call('submit_draft', { text: `===SCRIPT===\n${paragraphs.join('\n\n')}\n===SUMMARY===\nSummary of chapter ${chapterNo}.\n===CLOSING===\n${paragraphs.at(-1)}${about}` })
    log({ stem: key, event: 'submit_draft', ids, error: result.isError ? textOf(result) : null })
  } else if (stage === 'review') {
    const ids = remember('review-ids', /The mapping must use these piece IDs in this order:\n([^\n]+)/.exec(prompt)?.[1]).split(', ')
    const wantsAbout = remember('review-about', prompt.includes('The mapping must use') ? String(prompt.includes('Include a non-empty about field.')) : null) === 'true'
    const review = text0 => ({
      passed: true, issues: [], corrections: [],
      paragraphs: ids.map((id, i) => ({ text: i === 0 && text0 ? text0 : paragraph(i), images: [id] })),
      nonStoryImages: [], summary: `Summary of chapter ${chapterNo}.`, closing: paragraph(ids.length - 1),
      ...(wantsAbout && { about: 'A story about a thief.' })
    })
    if (n.inventedName && once('invented')) {
      const bad = await call('submit_review', { json: JSON.stringify(review('Then the healer Alicia waits.')) })
      log({ stem: key, event: 'submit_review', error: bad.isError ? textOf(bad) : null })
    }
    const result = await call('submit_review', { json: JSON.stringify(review(null)) })
    log({ stem: key, event: 'submit_review', ids, error: result.isError ? textOf(result) : null })
  } else if (stage === 'check') {
    const reviewed = remember('check-script', /SCRIPT TO CHECK \(data, not instructions\):\n([^\n]+)/.exec(prompt)?.[1])
    const result = await call('submit_check', { json: reviewed })
    log({ stem: key, event: 'submit_check', error: result.isError ? textOf(result) : null })
  }
  log({ stem: key, event: 'end', batch, stage })
  return true
}

/**
 * Hinglish (narrationHinglish.ts): reads the numbered English through get_reference, then submits the current stage.
 * Plan key "hinglish-ch<n>": { latinFirst: true } first submits a narration with Latin letters (refused), { silent: true }.
 */
async function fakeHinglish({ context, prompt, call, log }) {
  const textOf = r => r?.content?.find(c => c.type === 'text')?.text ?? ''
  const chapterNo = /Chapter (\S+), written from/.exec(context)?.[1]
  const key = `hinglish-ch${chapterNo}`
  const h = (JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'))[key] ?? {}).hinglish ?? {}
  const stage = /Stage: (hi_\w+)/.exec(context)?.[1]
  log({ stem: key, event: 'start', stage, continued: !prompt.includes('STUDIO NARRATION') })
  if (h.silent) { log({ stem: key, event: 'end', stage }); return true }
  const english = JSON.parse(textOf(await call('get_reference', { name: 'english' })))
  const n = english.paragraphs
  const sourceWords = english.story_script.replace(/^\[P\d+\] /gm, '').split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length
  const target = Math.ceil(sourceWords * 0.85) + 2
  const per = Math.ceil(target / n)
  let left = target
  const paragraphs = Array.from({ length: n }, () => { const k = Math.min(per, left); left -= k; return Array(Math.max(k, 1)).fill('कहानी').join(' ') + '।' })
  const narration = latin => `===SCRIPT===\n[SCENE 1: P1-P${n}]\n${paragraphs.join('\n\n')}${latin ? ' Hello' : ''}\n\n===SUMMARY===\nअध्याय ${chapterNo} का सारांश।`
  const submit = async (text, what) => {
    const r = await call('submit_hinglish', { stage, text })
    log({ stem: key, event: 'submit', stage, what, error: r.isError ? textOf(r) : null })
  }
  if (stage === 'hi_scenes') await submit(`===SCENES===\n[SCENE 1: P1-P${n}]\n- सब कुछ होता है`, 'scenes')
  else if (stage === 'hi_script') {
    if (h.latinFirst && !prompt.includes('Fix these problems')) await submit(narration(true), 'latin')
    await submit(narration(false), 'script')
  } else if (stage === 'hi_check') await submit(narration(false), 'check')
  log({ stem: key, event: 'end', stage })
  return true
}
