import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { parseAnalysis } from '../analysisImport.js'
import { audit, greyscaleLuma, lumaFromImage } from '../cropAudit.js'
import { javaDoubleToString, parseJson, trimIndent } from '../json.js'
import { correctionPrompt, extractJson, renderAnalysisPrompt, renderReviewPrompt, stripMarkdownFence } from '../prompts.js'
import { applyReply, auditInput, blockers, items, parseState, seed, toJson } from '../reviewState.js'
import { CONTINUITY_RULES, DEFAULT_ANALYSIS_TEMPLATE, DEFAULT_CROP_RULES, renderTemplate, templateSlots } from '../templates.js'
import type { AnalysisParseResult, AuditReport, Box, Handoff, ImportIssue, LumaPage, ReviewState } from '../types.js'

// Goldens were produced by compiling the phone's own Kotlin (CropSceneRules, Handoff, Json, CropAudit,
// CropReview, AnalysisImport, plus verbatim copies of GeometryWorkflow.prompt and CROP_RULES_PROMPT) with
// kotlinc 2.2 and running fixtures/kotlin/GenerateGoldens.kt on the same inputs as below.
const golden = (name: string) => readFileSync(new URL(`./fixtures/kotlin/${name}`, import.meta.url), 'utf8')

const SHA = '0123456789abcdef'.repeat(4)
const JOB = 'solo_leveling-ch010-page_003-0123456789ab'
const NOW = '2026-11-07T10:01:00.000Z'

function handoff3(): Handoff {
  return {
    jobId: JOB,
    wholePage: false,
    source: { seriesTitle: 'Solo Leveling', seriesSlug: 'solo_leveling', chapterFolder: 'Chapter 10', chapterNumber: '10', pageStem: 'page_003', originalFilename: 'page_003.jpg', sha256: SHA, width: 800, height: 5000, format: 'jpeg' },
    slices: [
      { id: 'slice-01', file: 'slice-01.webp', x0: 0, y0: 0, x1: 800, y1: 2048, width: 800, height: 2048 },
      { id: 'slice-02', file: 'slice-02.webp', x0: 0, y0: 2048, x1: 800, y1: 4096, width: 800, height: 2048 },
      { id: 'slice-03', file: 'slice-03.webp', x0: 0, y0: 4096, x1: 800, y1: 5000, width: 800, height: 904 },
    ],
  }
}

function handoffWhole(): Handoff {
  return {
    jobId: 'tower-ch002-page_009-fedcba987654',
    wholePage: true,
    source: { seriesTitle: 'Tower', chapterFolder: 'Chapter 2', pageStem: 'page_009', sha256: 'f'.repeat(64), width: 700, height: 1200 },
    slices: [{ id: 'slice-01', file: 'page_009.png', y0: 0, y1: 1200, width: 700, height: 1200 }],
  }
}

/** The synthetic page GenerateGoldens.kt audits: checkerboard "artwork" on white. */
function lumaPage(): LumaPage {
  const w = 800
  const h = 5000
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const checker = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0
      let v = 255
      if (y >= 100 && y < 1600 && x >= 40 && x < 760) v = checker ? 20 : 200
      else if (y >= 1700 && y < 2100) v = checker ? 20 : 200
      else if (y >= 2248 && y < 4196) v = checker ? 30 : 220
      else if (y >= 4596 && y < 4896 && x >= 300 && x < 700) v = checker ? 10 : 180
      data[y * w + x] = v
    }
  }
  return { width: w, height: h, data }
}

function c(id: string, s0: string, x0: number, y0: number, s1: string, x1: number, y1: number, reason = 'framed_shot', flags = '[]'): string {
  return `{"candidate_id":"${id}","reason":"${reason}","top_left":{"slice_id":"${s0}","x":${x0},"y":${y0}},"bottom_right":{"slice_id":"${s1}","x":${x1},"y":${y1}},"visual_evidence":"Visible border","review_flags":${flags}}`
}

function analysisReply(cands: string[], jobId = JOB, complete = true): string {
  return `{"schema_version":"chatgpt-analysis/1.0","job_id":"${jobId}","source_sha256":"${SHA}","page_stem":"page_003","source_width":800,"source_height":5000,"coordinate_system":"slice_local_pixels","page_inspection_complete":${complete},"page_review_flags":[],"candidates":[${cands.join(',')}]}`
}

const CANDS = [
  c('candidate-01', 'slice-01', 40, 100, 'slice-01', 760, 900, 'framed_shot', '["boundary_uncertain","weird_flag"]'),
  c('candidate-02', 'slice-01', 40, 900, 'slice-01', 760, 1500),
  c('candidate-03', 'slice-02', 0, 200, 'slice-03', 800, 100, 'tall_action'),
  c('candidate-04', 'slice-03', 100, 300, 'slice-03', 140, 340),
  c('candidate-05', 'slice-03', 100, 300, 'slice-03', 141, 340),
  c('candidate-06', 'slice-03', 300, 500, 'slice-03', 700, 800),
  c('candidate-07', 'slice-03', 450, 550, 'slice-03', 700, 800, 'speech_bubble'),
]

// Kotlin's toString of the values the generator prints.
const kBox = (b: Box) => `Box(x0=${b.x0}, y0=${b.y0}, x1=${b.x1}, y1=${b.y1})`
const kList = (l: string[]) => `[${l.join(', ')}]`
const dumpIssues = (list: ImportIssue[]) => list.map((i) => `${i.code}|${i.field}|${i.message}|${i.candidateId}`).join('\n')

function pipeline() {
  const h = handoff3()
  const parsed = parseAnalysis(analysisReply(CANDS), h, true)
  const seeded = seed(parsed.analysis!, NOW)
  const luma = lumaPage()
  const input = auditInput(seeded)
  const report = audit(seeded.sourceWidth, seeded.sourceHeight, input.crops, luma, input.reasons)
  const its = items(seeded, report.findings)
  return { h, parsed, seeded, luma, report, its }
}

function reAudit(state: ReviewState, luma: LumaPage | null): AuditReport {
  const input = auditInput(state)
  return audit(state.sourceWidth, state.sourceHeight, input.crops, luma, input.reasons)
}

describe('analysis prompt', () => {
  it('matches the Kotlin template for a 3-slice handoff, written out by hand', () => {
    const K = ' '.repeat(12)
    const expected = [
      'CROP RULES — use these to decide WHAT to crop and where each edge goes.',
      'Ignore any output format, file naming or normalized-coordinate instructions inside them:',
      'the JSON contract further down always wins.',
      '',
      '=== BEGIN CROP RULES ===',
      'RULE A',
      '=== END CROP RULES ===',
      '',
      `${K}Find every illustrated shot in this ONE page and measure its rectangle. This is geometry-only clipping: do not create descriptions or script associations.`,
      `${K}SHOT CONTINUITY — apply before choosing crop boundaries`,
      '- One continuous composition stays ONE crop, including all characters and objects sharing it. Start with real drawn panel borders and gutters. Separate unframed shots only when there is a visible artwork break or a distinct camera view/inset, not merely a change of subject, scale, expression, shading or background within the same composition.',
      "- Never place an internal boundary through a continuous face, hair, body, hand, clothing or object to create two crops. A child's hair above and face/body below are one shot; attendants behind a child are one group shot; a hand and the object it interacts with remain together in one continuous scene.",
      "- A head, hair, hand, body or SFX that breaks out past a panel's drawn border belongs to that panel: one crop holds the panel and its pop-out. The frame line the figure crosses is not a split, and a change of background pattern or effect inside one panel is not one either.",
      '- Two crops never meet edge to edge on one line unless a drawn panel border, gutter or clear artwork break runs along that whole line. If you are about to end one crop exactly where the next begins, check that line first: when the same figure, object or panel continues across it, make it one crop.',
      '- A slice seam, image edge between uploads, top/middle/bottom hint, crop label, target crop count or aspect ratio is not a drawn panel boundary. Keep a continuous shot whole across slices, however tall it is.',
      '- Speech bubbles, narration and SFX never justify a crop or a split.',
      '- Before accepting separate crops, trace the proposed dividing edge on the source artwork. If subject outlines or the same composition continue across it without a real shot boundary, use one enclosing crop. Matching backgrounds alone do not prove continuity: retain separate panels and genuine distinct shots.',
      '- Size and height checks request inspection, never a split. If the boundary cannot be verified, keep the complete continuous composition and flag boundary_uncertain rather than inventing a cut.',
      `${K}Inspect all attached slices top to bottom, left to right. A slice seam is never a shot boundary. Exclude isolated bubbles, captions and SFX over filler backgrounds.`,
      `${K}Corners use slice-local integer pixels; bottom_right is exclusive. Each corner identifies the slice it falls in. A crop may span slices.`,
      `${K}slice-01: 800x2048, original page y=0..2048`,
      'slice-02: 800x2048, original page y=2048..4096',
      'slice-03: 800x904, original page y=4096..5000',
      `${K}Return JSON only: {"schema_version":"chatgpt-analysis/1.0","job_id":"${JOB}","source_sha256":"${SHA}","page_stem":"page_003","source_width":800,"source_height":5000,"coordinate_system":"slice_local_pixels","page_inspection_complete":true,"page_review_flags":[],"candidates":[{"candidate_id":"candidate-01","reason":"illustrated_shot","top_left":{"slice_id":"slice-01","x":0,"y":0},"bottom_right":{"slice_id":"slice-01","x":800,"y":2048},"visual_evidence":"Visible shot boundary","review_flags":[]}]}`,
      `${K}The candidate above is an example, not a target crop. Return an empty candidates array only for a page with no eligible artwork. Never invent an internal shot boundary.`,
    ].join('\n')
    expect(renderAnalysisPrompt({ handoff: handoff3(), cropRules: '  RULE A\n' })).toBe(expected)
  })

  it('keeps Kotlin trimIndent semantics: the interpolated raw string trims to the default template', () => {
    // The phone's raw string, interpolated before trimIndent() runs.
    const raw = '\n' + DEFAULT_ANALYSIS_TEMPLATE.replace('{{CONTINUITY_RULES}}', CONTINUITY_RULES) + '\n        '
    expect(trimIndent(raw)).toBe(raw.slice(1, -9))
  })

  it('equals the Kotlin output with the default Crop Rules (sliced and whole page)', () => {
    expect(DEFAULT_CROP_RULES).toBe(golden('crop-rules.txt'))
    expect(renderAnalysisPrompt({ handoff: handoff3() })).toBe(golden('analysis-prompt.txt'))
    expect(renderAnalysisPrompt({ handoff: handoffWhole() })).toBe(golden('analysis-prompt-whole.txt'))
  })

  it('omits blank rules and documents its slots', () => {
    expect(renderAnalysisPrompt({ handoff: handoff3(), cropRules: ' \n' }).startsWith(`${' '.repeat(12)}Find every`)).toBe(true)
    expect(templateSlots(DEFAULT_ANALYSIS_TEMPLATE)).toEqual([
      'CONTINUITY_RULES', 'SLICE_LINES', 'ANALYSIS_SCHEMA', 'JOB_ID', 'SOURCE_SHA256', 'PAGE_STEM', 'SOURCE_WIDTH',
      'SOURCE_HEIGHT', 'COORDINATE_SYSTEM', 'FIRST_SLICE_ID', 'FIRST_SLICE_HEIGHT',
    ])
    expect(renderTemplate('{{A}} {{B}}', { A: '{{B}}' })).toBe('{{B}} {{B}}')
  })
})

describe('analysis import', () => {
  const h = handoff3()
  const parse = (text: string) => parseAnalysis(text, h, true)

  const cases: [string, string][] = [
    ['wrong-job', analysisReply(CANDS.slice(0, 1), 'nope')],
    ['oob', analysisReply([c('candidate-01', 'slice-01', 40, 100, 'slice-01', 900, 3000)])],
    ['unknown-slice', analysisReply([c('candidate-01', 'slice-07', 40, 100, 'slice-01', 700, 300)])],
    ['dup', analysisReply([CANDS[0]!, CANDS[0]!])],
    ['empty-complete', analysisReply([])],
    ['empty-incomplete', analysisReply([], JOB, false)],
    ['fence', '```json\n' + analysisReply(CANDS.slice(0, 1)) + '\n```'],
    ['messy', analysisReply([
      '{"candidate_id":"  x1 ","reason":"Framed Reaction!","top_left":{"slice_id":"slice-01","x":40.0,"y":100},"bottom_right":{"slice_id":"slice-02","x":760,"y":10},"description":"A man.","review_flags":["tall_continuous_scene","tall_continuous_scene","odd"],"extra":1}',
      '{"candidate_id":"","reason":"   ","top_left":{"slice_id":"slice-01","x":1.5,"y":"3"},"bottom_right":5,"visual_evidence":7}',
      '{"candidate_id":"x2","reason":"!!!","top_left":{"slice_id":"slice-01","x":100,"y":100},"bottom_right":{"slice_id":"slice-01","x":50,"y":100}}',
    ]).replace('"page_review_flags":[]', '"page_review_flags":["needs_closer_view"],"bonus":true')],
    ['canonical', `{"schema_version":"chatgpt-analysis/1.0","job_id":"${JOB}","source_sha256":"${SHA}","page_stem":"page_003","source_width":800.0,"source_height":5000,"coordinate_system":"canonical_original_pixels","page_inspection_complete":true,"candidates":[{"candidate_id":"a","reason":"x","bounds":{"x0":0,"y0":0,"x1":800,"y1":5001}},{"candidate_id":"b","reason":"y","bounds":{"x0":0,"y0":10,"x1":800,"y1":500}}]}`],
    ['identity', '{"schema_version":"chatgpt-analysis/2","job_id":5,"source_sha256":null,"page_stem":"page_003","source_width":true,"source_height":"5000","coordinate_system":"pixels","page_inspection_complete":"yes","page_review_flags":[1],"candidates":{}}'],
    ['not-object', '[1,2]'],
  ]

  const dump = (name: string, r: AnalysisParseResult) =>
    `${name}\n${dumpIssues(r.errors)}\n--warnings--\n${dumpIssues(r.warnings)}\n--candidates--\n` +
    (r.analysis === null ? 'null' : r.analysis.candidates.map((x) =>
      `${x.candidateId}|${x.reason}|${kBox(x.bounds)}|${kList(x.slices)}|${kList(x.reviewFlags)}|${kList(x.unknownFlags)}|${x.visualEvidence}|${x.description}`).join('\n'))

  it('gives the same errors, warnings and candidates as the Kotlin for every case', () => {
    expect(cases.map(([name, text]) => dump(name, parse(text))).join('\n==\n')).toBe(golden('analysis-rejections.txt'))
  })

  it('accepts a good reply and converts slice-local corners to page pixels in reading order', () => {
    const r = parse(analysisReply(CANDS))
    expect(r.errors).toEqual([])
    expect(dumpIssues(r.warnings) + '\n--\n' + dumpIssues(r.errors)).toBe(golden('analysis-warnings.txt'))
    expect(r.analysis!.candidates.map((x) => x.candidateId)).toEqual(['candidate-01', 'candidate-02', 'candidate-03', 'candidate-04', 'candidate-05', 'candidate-06', 'candidate-07'])
    expect(r.analysis!.candidates[2]!.bounds).toEqual({ x0: 0, y0: 2248, x1: 800, y1: 4196 })
    expect(r.analysis!.candidates[2]!.slices).toEqual(['slice-02', 'slice-03'])
  })

  it('rejects the wrong job_id, out-of-bounds corners, unknown slices and duplicate ids', () => {
    const [wrongJob, oob, unknown, dup] = cases.slice(0, 4).map(([, t]) => parse(t))
    expect(wrongJob!.analysis).toBeNull()
    expect(wrongJob!.errors.map((e) => [e.code, e.field])).toEqual([['GPT_PAGE_MISMATCH', 'job_id']])
    expect(oob!.errors[0]!.message).toBe("candidate-01: bottom_right.x 900 is outside slice-01's width 0–800")
    expect(unknown!.errors[0]!.field).toBe('candidates[0].top_left.slice_id')
    expect(dup!.errors[0]!.message).toBe('Duplicate candidate_id "candidate-01"')
  })

  it('accepts empty candidates with a warning, plus an uncertainty warning when inspection is incomplete', () => {
    const complete = parse(analysisReply([]))
    const incomplete = parse(analysisReply([], JOB, false))
    expect(complete.analysis!.candidates).toEqual([])
    expect(complete.warnings.map((w) => w.code)).toEqual(['EMPTY_CANDIDATES'])
    expect(incomplete.warnings.map((w) => w.code)).toEqual(['EMPTY_CANDIDATES', 'GPT_VISUAL_UNCERTAINTY'])
    expect(incomplete.analysis!.pageInspectionComplete).toBe(false)
  })

  it('strips a Markdown fence and records it', () => {
    expect(stripMarkdownFence('```json\n{"a":1}\n```\n')).toEqual(['{"a":1}', true])
    expect(stripMarkdownFence('{"a":1}')).toEqual(['{"a":1}', false])
    expect(parse('```json\n' + analysisReply([]) + '\n```').warnings[0]!.code).toBe('MARKDOWN_FENCE_STRIPPED')
    expect(extractJson('Here you go:\n```json\n {"a":1} \n```\nThanks')).toBe('{"a":1}')
    expect(extractJson('Sure! {"a":{"b":1}} done')).toBe('{"a":{"b":1}}')
  })

  it("reads replies with Android org.json's leniency", () => {
    // Comments, single quotes, unquoted keys and `=` separators parse on the phone.
    const lenient = analysisReply([]).replace('"page_stem":"page_003"', "page_stem='page_003' /* ok */").replace('{"schema_version"', '{ // hi\n"schema_version"')
    expect(parse(lenient).analysis).not.toBeNull()
    // An empty array slot is a null, which is not a string.
    expect(parse(analysisReply([]).replace('"page_review_flags":[]', '"page_review_flags":["a",]')).errors[0]!.message).toBe('page_review_flags must be an array of strings')
    // Octal and hex integers.
    expect(parse(analysisReply([c('o', 'slice-01', 0, 0, 'slice-01', 800, 10)]).replace('"x":0,', '"x":010,')).analysis!.candidates[0]!.bounds.x0).toBe(8)
    // Trailing prose and a trailing comma in an object are refused.
    expect(parse(analysisReply([]) + ' thanks').errors[0]!.message).toBe('The reply is not valid JSON: Unexpected text after the JSON value')
    expect(parse('{"a":1,}').errors[0]!.message).toBe('The reply is not valid JSON: Expected literal value at character 7 of {"a":1,}')
    expect(parse('{"a":NaN}').errors[0]!.message).toBe('The reply is not valid JSON: Forbidden numeric value: NaN')
    expect(parseJson('﻿[1,,2]')).toMatchObject({ items: [{ value: 1 }, undefined, { value: 2 }] })
    expect(javaDoubleToString(0.3402406417112304)).toBe('0.3402406417112304')
  })
})

describe('crop audit', () => {
  it('gives the same findings and gaps as the Kotlin on a synthetic luma page', () => {
    const { report } = pipeline()
    const text = report.findings.map((f) => `${f.token}|${f.key}|${f.message}`).join('\n') + '\n--\n' +
      report.gaps.map((g) => `${g.y0}|${g.y1}|${g.inkShare === null ? 'null' : javaDoubleToString(g.inkShare)}`).join('\n')
    expect(text).toBe(golden('audit.txt'))
  })

  it('flags tall, duplicate, overlapping, shared-edge and tiny crops, and measures gap ink', () => {
    const { report } = pipeline()
    const tokens = report.findings.map((f) => `${f.key} ${f.token}`)
    expect(tokens).toEqual(expect.arrayContaining([
      'candidate-03 TALL_ASPECT',
      'candidate-05 DUPLICATE:candidate-04',
      'candidate-07 HIGH_OVERLAP:candidate-06',
      'candidate-02 SHARED_EDGE:candidate-01',
      'candidate-04 TINY',
      'candidate-04 MOSTLY_BLANK',
      'candidate-01 EDGE_ON_CONTENT:bottom',
    ]))
    expect(report.gaps.map((g) => [g.y0, g.y1])).toEqual([[1500, 2248], [4196, 4396]])
    expect(report.gaps[0]!.inkShare).toBeCloseTo(0.34024, 5)
    expect(report.gaps[1]!.inkShare).toBe(0)
  })

  it('reproduces the phone greyscale and decodes images with sharp', async () => {
    expect(greyscaleLuma(255, 255, 255)).toBe(255)
    expect(greyscaleLuma(0, 0, 0)).toBe(0)
    for (const v of [17, 64, 128, 200]) expect(Math.abs(greyscaleLuma(v, v, v) - v)).toBeLessThanOrEqual(1)
    const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 120, 60, 30])
    const png = await sharp(rgb, { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()
    const luma = await lumaFromImage(png)
    expect([luma.width, luma.height]).toEqual([2, 2])
    expect([...luma.data]).toEqual([greyscaleLuma(255, 0, 0), greyscaleLuma(0, 255, 0), greyscaleLuma(0, 0, 255), greyscaleLuma(120, 60, 30)])
  })
})

describe('review round', () => {
  it('seeds and blocks exactly like the Kotlin', () => {
    const { seeded, its } = pipeline()
    expect(toJson(seeded)).toBe(golden('seeded.json'))
    expect(blockers(seeded, its, true).map((b) => `${b.code}|${b.message}|${b.key}`).join('\n')).toBe(golden('blockers-1.txt'))
  })

  it('renders the geometry-only review prompt byte for byte', () => {
    const { h, seeded, its, report } = pipeline()
    const prompt = renderReviewPrompt({ state: seeded, items: its, audit: report, handoff: h })
    expect(prompt).toBe(golden('review-prompt.txt'))
    expect(prompt).toContain('"token": "SHARED_EDGE:candidate-01"')
    expect(prompt).toContain('"gpt:boundary_uncertain"')
    expect(prompt).toContain('  slice-01 y 1500 → slice-02 y 200 (34% ink)\n1 other uncovered stretch looks like plain background')
    expect(prompt).not.toContain('redescribe_keys')

    const noLuma = reAudit(seeded, null)
    expect(renderReviewPrompt({ state: seeded, items: items(seeded, noLuma.findings), audit: noLuma, handoff: h })).toBe(golden('review-prompt-noluma.txt'))
  })

  it('renders the empty-page and whole-page variants byte for byte', () => {
    const h = handoff3()
    const empty = seed(parseAnalysis(analysisReply([]), h, true).analysis!, 't')
    expect(renderReviewPrompt({ state: empty, items: [], audit: audit(800, 5000, [], lumaPage()), handoff: h })).toBe(golden('review-prompt-empty.txt'))

    const hw = handoffWhole()
    const reply = `{"schema_version":"chatgpt-analysis/1.0","job_id":"${hw.jobId}","source_sha256":"${'f'.repeat(64)}","page_stem":"page_009","source_width":700,"source_height":1200,"coordinate_system":"slice_local_pixels","page_inspection_complete":true,"candidates":[{"candidate_id":"candidate-01","reason":"wide","top_left":{"slice_id":"slice-01","x":0,"y":0},"bottom_right":{"slice_id":"slice-01","x":700,"y":500}}]}`
    const ws = seed(parseAnalysis(reply, hw, true).analysis!, 't')
    const wa = audit(700, 1200, auditInput(ws).crops, null)
    expect(renderReviewPrompt({ state: ws, items: items(ws, wa.findings), audit: wa, handoff: hw })).toBe(golden('review-prompt-whole.txt'))
  })

  it('applies keep, adjust, split, merge, add and remove like the Kotlin', () => {
    const { h, seeded, its, luma } = pipeline()
    const r = applyReply(golden('review-reply.txt'), seeded, its, h, '2026-11-07T10:02:00.000Z', true)
    expect(`${dumpIssues(r.warnings)}\n--\n${dumpIssues(r.errors)}\n--\n${r.changed}`).toBe(golden('applied-issues.txt'))
    const next = r.state!
    expect(toJson(next)).toBe(golden('applied.json'))
    expect(next.crops.map((x) => `${x.key}:${x.disposition}`)).toEqual([
      'candidate-01:merged', 'candidate-03.a:split', 'candidate-03.b:split', 'candidate-04:kept', 'candidate-06:adjusted', 'op-01:adjusted',
    ])
    expect(next.crops[3]!.acknowledged).toEqual(['TINY', 'MOSTLY_BLANK'])
    expect(next.revision).toBe(2)

    const report2 = reAudit(next, luma)
    const items2 = items(next, report2.findings)
    expect(blockers(next, items2, true).map((b) => `${b.code}|${b.message}|${b.key}`).join('\n')).toBe(golden('blockers-2.txt'))
    expect(renderReviewPrompt({ state: next, items: items2, audit: report2, handoff: h })).toBe(golden('review-prompt-2.txt'))
    expect(parseState(toJson(next))).toEqual(next)
  })

  it('rejects a dropped key, a wrong review_revision and bad coordinates like the Kotlin', () => {
    const { h, seeded, its } = pipeline()
    const reply = golden('review-reply.txt')
    const bad: [string, string][] = [
      ['drop-key', reply.replace('"removed_keys":["candidate-05","candidate-07"]', '"removed_keys":["candidate-05"]')],
      ['wrong-revision', reply.replace('"review_revision":1', '"review_revision":2')],
      ['bad-coords', reply.replace('"x":720,"y":800', '"x":801,"y":800').replace('"slice_id":"slice-01","x":0,"y":1700', '"slice_id":"slice-09","x":0,"y":1700')],
      ['twice', reply.replace('"removed_keys":["candidate-05","candidate-07"]', '"removed_keys":["candidate-05","candidate-07","candidate-04"]')],
      ['wrong-schema', reply.replace('clipper-review-geometry/1.0', 'chatgpt-review/1.0').replace(JOB, 'other')],
      ['fraction', reply.replace('"x":140,"y":340', '"x":140.5,"y":"340"')],
      ['inverted', reply.replace('"x":140,"y":340', '"x":90,"y":340')],
    ]
    const results = bad.map(([name, text]) => [name, applyReply(text, seeded, its, h, 'now', true)] as const)
    expect(results.map(([name, r]) => `${name}\n${dumpIssues(r.errors)}\n--correction--\n${correctionPrompt(r.errors)}`).join('\n==\n'))
      .toBe(golden('review-rejections.txt'))
    for (const [, r] of results) expect(r.state).toBeNull()
    expect(results[0]![1].errors[0]!.message).toContain('Not accounted for: candidate-07.')
    expect(results[1]![1].errors[0]!.field).toBe('review_revision')
    expect(results[2]![1].errors.map((e) => e.code)).toEqual(['GPT_COORDINATES_INVALID', 'GPT_COORDINATES_INVALID'])
  })

  it('shapes the correction prompt, capping the list', () => {
    const issue = (n: number): ImportIssue => ({ code: 'X', field: n % 2 ? `f${n}` : '', message: `m${n}`, candidateId: null })
    expect(correctionPrompt([issue(1), issue(2)])).toBe(
      "The app's validator REJECTED that reply. Problems:\n- f1: m1\n- m2\n\nFix every problem and return the COMPLETE corrected JSON object (not a diff), with no prose.",
    )
    const many = correctionPrompt(Array.from({ length: 27 }, (_, i) => issue(i)))
    expect(many.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(26)
    expect(many).toContain('\n- …and 2 more\n')
  })
})
