import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { YouTubeStore } from '../youtubeStore.js'
import { parseTitleResponse, parseYouTubeJson, validateTitle } from '../youtubeTitles.js'
import { createYouTubeRouter } from '../../routes/youtube.js'
import type { YouTubeWorkspace } from '../youtubeTypes.js'

let root: string
let store: YouTubeStore
let server: Server | undefined
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-youtube-titles-'))
  const defaults = path.join(root, 'defaults')
  await fs.mkdir(defaults)
  await fs.writeFile(path.join(defaults, 'title-guidelines.md'), 'Title guideline alpha: use specific factual hooks, not generic hype.')
  await fs.writeFile(path.join(defaults, 'thumbnail-guidelines.md'), 'Thumbnail guideline alpha: one dominant character and a short caption.')
  await fs.writeFile(path.join(defaults, 'description-guidelines.md'), 'Use verified story context in concise English descriptions.')
  store = new YouTubeStore(path.join(root, 'data'), defaults)
})
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    server = undefined
  }
  await fs.rm(root, { recursive: true, force: true })
})

const five = ['Everyone Calls Him Weak Until He Learns to Copy Their Skills', 'A Rookie Hunter Discovers He Can Borrow His Rivals’ Talents', 'They Ignore His Rank But His Copying Skill Changes Every Fight', 'He Enters the Academy With One Skill Nobody Understands', 'A Weak Hunter Can Learn the Powers His Rivals Spent Years Training']
const otherFive = ['His Rivals Train for Years But He Learns Their Skills in One Encounter', 'They Dismiss the New Hunter Until Their Own Techniques Return', 'One Forgotten Talent Lets a Rookie Challenge the Academy’s Best', 'The Academy’s Weakest Hunter Has an Advantage Nobody Can See', 'He Starts With Nothing Until Every New Rival Becomes His Teacher']
function response(workspace: YouTubeWorkspace, titles = five) {
  return {
    schemaVersion: 1, requestId: workspace.titles.requests.at(-1)!.id, seriesId: workspace.seriesId, language: 'en', status: 'ok',
    research: { resolvedTitle: 'Test Hunter', summary: 'A fictional test series premise used only for local validation.', sources: [{ title: 'Publisher synopsis', url: 'https://www.webtoons.com/en/fantasy/test-hunter/list' }, { title: 'Second source', url: 'https://tapas.io/series/test-hunter/info' }] }, titles: [...titles]
  }
}
async function prepared(id = 'a') {
  const workspace = await store.openWorkspace(id)
  return store.prepareTitles(id, 'Test Hunter', workspace.titles.revision)
}

describe('title prompts and durable workspaces', () => {
  it('snapshots current guidelines and exact series identity in a copyable five-title research prompt', async () => {
    const first = await prepared()
    const request = first.titles.requests[0]
    expect(request.prompt).toContain('Title guideline alpha')
    expect(request.prompt).toContain('Open and read at least two relevant sources')
    expect(request.prompt).toContain('WRITE EXACTLY FIVE')
    expect(request.prompt).toContain('"seriesName": "Test Hunter"')
    expect(request.prompt).toContain(request.id)
    expect(request.prompt).toContain('Do not add part numbers')
    const before = await store.guidelines()
    const nextGuideline = await store.replace('title', Buffer.from('Title guideline beta: use new updated instructions.'), 'beta.txt', before.title.id)
    const second = await store.prepareTitles('a', 'Test Hunter', first.titles.revision)
    expect(second.titles.requests[0].prompt).toBe(request.prompt)
    expect(second.titles.requests[1].guidelineVersion).toBe(nextGuideline.id)
    expect(second.titles.requests[1].prompt).toContain('Title guideline beta')
    await expect(new YouTubeStore(path.join(root, 'data')).openWorkspace('a')).resolves.toEqual(second)
  })

  it('imports exactly five titles, retains research, and does not choose a title automatically', async () => {
    const first = await prepared()
    const payload = JSON.stringify(response(first))
    const imported = await store.importTitles('a', first.titles.requests[0].id, payload, first.titles.revision)
    expect(imported.titles.suggestions.map(item => item.title)).toEqual(five)
    expect(imported.selectedTitle).toBeNull()
    expect(imported.titles.requests[0].response?.research.sources).toHaveLength(2)
    expect(imported.titles.requests[0].importedAt).not.toBeNull()
    expect(await store.importTitles('a', first.titles.requests[0].id, payload, first.titles.revision)).toEqual(imported)
  })

  it('appends five more, excludes prior choices in the prompt, and preserves selection and old research', async () => {
    let state = await prepared()
    state = await store.importTitles('a', state.titles.requests[0].id, JSON.stringify(response(state)), state.titles.revision)
    state = await store.selectTitle('a', { suggestionId: state.titles.suggestions[1].id, expectedRevision: state.titles.revision })
    state = await store.prepareTitles('a', 'Test Hunter', state.titles.revision)
    expect(state.titles.requests[1].prompt).toContain(five[1])
    expect(state.titles.requests[1].prompt).toContain('PREVIOUS RESEARCH')
    state = await store.importTitles('a', state.titles.requests[1].id, JSON.stringify(response(state, otherFive)), state.titles.revision)
    expect(state.titles.suggestions).toHaveLength(10)
    expect(state.selectedTitle).toBe(five[1])
    expect(state.titles.requests[0].response?.titles).toEqual(five)
    const reopened = await new YouTubeStore(path.join(root, 'data')).openWorkspace('a')
    expect(reopened).toEqual(state)
  })

  it('rejects duplicate prior suggestions without partially importing or losing chosen work', async () => {
    let state = await prepared()
    state = await store.importTitles('a', state.titles.requests[0].id, JSON.stringify(response(state)), state.titles.revision)
    state = await store.selectTitle('a', { title: 'My Own Factual Hunter Title', expectedRevision: state.titles.revision })
    state = await store.prepareTitles('a', 'Test Hunter', state.titles.revision)
    const rejected = response(state, [five[0].toUpperCase() + '!', ...otherFive.slice(1)])
    await expect(store.importTitles('a', state.titles.requests[1].id, JSON.stringify(rejected), state.titles.revision)).rejects.toThrow('repeats a previous')
    expect(await store.openWorkspace('a')).toEqual(state)
  })

  it('rejects responses from another series or request and changed replays', async () => {
    const a = await prepared('a')
    const b = await prepared('b')
    await expect(store.importTitles('a', a.titles.requests[0].id, JSON.stringify(response(b)), a.titles.revision)).rejects.toThrow('another prompt or series')
    await expect(store.importTitles('b', a.titles.requests[0].id, JSON.stringify(response(a)), b.titles.revision)).rejects.toMatchObject({ status: 404 })
    const imported = await store.importTitles('a', a.titles.requests[0].id, JSON.stringify(response(a)), a.titles.revision)
    await expect(store.importTitles('a', a.titles.requests[0].id, JSON.stringify(response(a, otherFive)), imported.titles.revision)).rejects.toMatchObject({ status: 409 })
    expect(await store.openWorkspace('b')).toEqual(b)
  })

  it('keeps custom choices in history, without requiring research or a prepared prompt', async () => {
    const workspace = await store.openWorkspace('a')
    const first = await store.selectTitle('a', { title: '  My English Title  ', expectedRevision: workspace.titles.revision })
    const second = await store.selectTitle('a', { title: 'Another English Title', expectedRevision: first.titles.revision })
    expect(second.titles.selections.map(item => item.title)).toEqual(['My English Title', 'Another English Title'])
    expect(second.titles.requests).toHaveLength(0)
    const prompt = await store.prepareTitles('a', 'Test Hunter', second.titles.revision)
    expect(prompt.titles.requests[0].prompt).toContain('My English Title')
    expect(prompt.titles.requests[0].prompt).toContain('Another English Title')
  })

  it('rejects stale changes and foreign suggestion IDs, preserving both windows’ existing data', async () => {
    const workspace = await prepared()
    const selected = await store.selectTitle('a', { title: 'My Custom Title', expectedRevision: workspace.titles.revision })
    await expect(store.prepareTitles('a', 'Test Hunter', workspace.titles.revision)).rejects.toMatchObject({ status: 409 })
    await expect(store.selectTitle('a', { title: 'Stale title', expectedRevision: workspace.titles.revision })).rejects.toMatchObject({ status: 409 })
    await expect(store.importTitles('a', workspace.titles.requests[0].id, JSON.stringify(response(workspace)), workspace.titles.revision)).rejects.toMatchObject({ status: 409 })
    await expect(store.selectTitle('a', { suggestionId: 'foreign', expectedRevision: selected.titles.revision })).rejects.toMatchObject({ status: 404 })
    expect(await store.openWorkspace('a')).toEqual(selected)
  })

  it('upgrades section 1 workspaces while preserving existing outputs and guideline versions', async () => {
    const before = await store.openWorkspace('old')
    const old = { ...before, description: 'Retained description', selectedThumbnail: 'retained.png', selectedTitle: 'Retained title' } as Partial<YouTubeWorkspace>
    delete old.titles
    const filename = path.join(root, 'data/workspaces', `${createHash('sha256').update('old').digest('hex')}.json`)
    await fs.writeFile(filename, JSON.stringify(old))
    const migrated = await store.openWorkspace('old')
    expect(migrated.titles.revision).toBe(0)
    expect(migrated.guidelineVersions).toEqual(old.guidelineVersions)
    const changed = await store.selectTitle('old', { title: 'New title', expectedRevision: 0 })
    expect(changed.description).toBe('Retained description')
    expect(changed.selectedThumbnail).toBe('retained.png')
    expect(changed.descriptionNeedsUpdate).toBe(true)
    expect(changed.thumbnailNeedsUpdate).toBe(true)
  })
})

describe('ChatGPT title response validation', () => {
  it('reads the supplied rich-text format with HTML indentation, line continuations and escaped URL colons', async () => {
    const raw = await fs.readFile(new URL('../../../tests/fixtures/youtube-title-richtext.txt', import.meta.url), 'utf8')
    const parsed = parseTitleResponse(raw, '433d250d-44b0-4e9e-bc4f-d59fdc406985', '6a6da4cf-4913-4002-be37-fc89c0164c13')
    expect(parsed.titles).toHaveLength(5)
    expect(parsed.titles[0]).toBe('Union Hired a Legendary Hitman to Destroy His Friend’s Company—Then Betrayed Them Both')
    expect(parsed.research.resolvedTitle).toBe('Bad Business (배드 비즈니스)')
    expect(parsed.research.sources.map(source => source.url)).toEqual(['https://mangabaka.org/manhwa/571685/Bad-Business', 'https://nextchapter.moe/series/bad-business-94785'])
    expect(() => parseTitleResponse(raw, 'another-request', parsed.seriesId)).toThrow('another prompt or series')
  })

  it('reads the exact pasted Skeleton King response including preceding commentary and escaped URL dots', async () => {
    const raw = await fs.readFile(new URL('../../../tests/fixtures/youtube-title-commentary-richtext.txt', import.meta.url), 'utf8')
    const value = parseTitleResponse(raw, '677e34ac-bf79-4627-a068-f9f1386d118c', '62757989-875d-43bf-bfad-3382a8cb0a73')
    expect(value.titles).toHaveLength(5)
    expect(value.titles[0]).toBe('The Gods Betrayed the Skeleton King—Now He’s Reborn as Their BABY SAINT!')
    expect(value.research.sources[0].url).toBe('https://www.cncrevolution.kr/ip/webtoon?category_code=1012&code=876&tpf=product/view')
    expect(value.research.summary).toContain('이 나라를 없앨 예정인데요')
    expect(() => parseTitleResponse(raw, 'wrong-request', value.seriesId)).toThrow('another prompt or series')
    expect(() => parseTitleResponse(raw, value.requestId, 'wrong-series')).toThrow('another prompt or series')
  })

  it('imports commentary-wrapped responses into the selected request without losing earlier titles', async () => {
    let state = await prepared()
    state = await store.importTitles('a', state.titles.requests[0].id, JSON.stringify(response(state)), state.titles.revision)
    const previous = state.titles.suggestions
    state = await store.prepareTitles('a', 'Test Hunter', state.titles.revision)
    const value = response(state)
    value.requestId = state.titles.requests.at(-1)!.id
    value.titles = ['A New Hunter Finds a Secret Door', 'The Academy Reveals a Hidden Test', 'One Apprentice Discovers a Lost Skill', 'The Hunter Escapes a Deadly Trap', 'His Forgotten Power Changes the Battle']
    const raw = 'Here are five more ideas.\n\n```json\n' + JSON.stringify(value, null, 2).replace(/\n/g, '\\\n') + '\n```\nThese are based on the researched series.'
    const saved = await store.importTitles('a', value.requestId, raw, state.titles.revision)
    expect(saved.titles.suggestions).toHaveLength(10)
    expect(saved.titles.suggestions.slice(0, 5)).toEqual(previous)
  })

  it('extracts a single container from prose and fences while preserving quoted braces and valid escapes', () => {
    const value = { summary: 'A {hidden} [skill] with "quoted" text, a newline\nand literal \\n; entity &#x20; stays literal.' }
    const json = JSON.stringify(value, null, 2)
    for (const raw of ['Explanation.\n' + json + '\nDone.', 'He says "look here".\n```json\n' + json + '\n```\nDone.', 'A note {not JSON}.\n' + json]) expect(parseYouTubeJson(raw)).toEqual(value)
    expect(parseYouTubeJson('Description ready:\n' + JSON.stringify({ description: 'Some {story} context.' }))).toEqual({ description: 'Some {story} context.' })
  })

  it('rejects ambiguous responses and never salvages nested JSON from truncated or invalid containers', () => {
    expect(() => parseYouTubeJson('First: {"a":1}\nSecond: {"a":2}')).toThrow('multiple JSON responses')
    expect(() => parseYouTubeJson('First: ```json\n{"a":1}\n```\nThen: {"a":2}')).toThrow('multiple JSON responses')
    for (const raw of ['Intro {"outer":{"valid":1}', 'Intro {"outer":{"valid":1},}', 'Intro {"outer":{"valid":1},"bad":"oops\\q"}']) expect(() => parseYouTubeJson(raw)).toThrow('not valid JSON')
    expect(parseYouTubeJson('Intro [{"a":1}]')).toEqual([{ a: 1 }])
    expect(() => parseYouTubeJson('x'.repeat(100_001) + '{"a":1}')).toThrow('100 KB')
  })

  it('preserves valid JSON escapes, Unicode, and literal entity text when recovering presentation escapes', async () => {
    const state = await prepared()
    const expected = response(state)
    expected.research.summary = 'Quoted "text", real newline\nplus a literal \\n, path C:\\new\\folder, and entities &#x20; &amp;.'
    expected.research.resolvedTitle = 'Hunter (헌터) &amp; Friends'
    const strict = JSON.stringify(expected, null, 2)
    const escaped = strict.replace(/^  /gm, '&#32; ').replace(/\n/g, '\\\r\n').replace(/https:/g, 'https\\:')
    expect(parseTitleResponse(escaped, expected.requestId, 'a')).toEqual(parseTitleResponse(strict, expected.requestId, 'a'))
    expect(parseTitleResponse('```json\n' + escaped + '\n```', expected.requestId, 'a').research.summary).toBe(expected.research.summary)
  })

  it('does not repair unknown escapes, truncated JSON or trailing commas', async () => {
    const state = await prepared()
    const expected = response(state)
    const strict = JSON.stringify(expected, null, 2)
    for (const raw of [strict.replace('Publisher synopsis', String.raw`Publisher\q synopsis`), strict.slice(0, -1), strict.replace(/\n}$/, ',\n}')]) {
      expect(() => parseTitleResponse(raw, expected.requestId, 'a')).toThrow('not valid JSON')
    }
  })

  it('accepts JSON code fences and Unicode punctuation without changing title content', async () => {
    const state = await prepared()
    const value = parseTitleResponse('```json\n' + JSON.stringify(response(state)) + '\n```', state.titles.requests[0].id, 'a')
    expect(value.titles).toEqual(five)
    expect(validateTitle('😀'.repeat(99) + 'A')).toHaveLength(199)
  })

  it.each([
    ['malformed JSON', 'not json', 'valid JSON'],
    ['bare list', JSON.stringify(five), 'another prompt or series']
  ])('rejects %s', (_label, raw, error) => {
    expect(() => parseTitleResponse(raw, 'request', 'a')).toThrow(error)
  })

  it('rejects missing research, incorrect counts, repeated titles, unsafe links and placeholder sources', async () => {
    const state = await prepared()
    const check = (modify: (value: any) => void, error: string) => {
      const value = response(state); modify(value)
      expect(() => parseTitleResponse(JSON.stringify(value), value.requestId, 'a')).toThrow(error)
    }
    check(value => { value.titles = five.slice(0, 4) }, 'exactly five')
    check(value => { value.titles[1] = five[0].toUpperCase() + '!' }, 'repeats')
    check(value => { value.research = null }, 'Researched series name')
    check(value => { value.research.sources[0].url = 'javascript:alert(1)' }, 'public HTTP')
    check(value => { value.research.sources[0].url = 'https://publisher.example/story' }, 'public HTTP')
    check(value => { value.research.sources[1].url = 'https://webtoons.com/other' }, 'different source sites')
    check(value => { value.titles[0] = 'X'.repeat(101) }, '100 characters')
    check(value => { value.titles[0] = 'Title\nwith new line' }, 'single line')
    check(value => { value.titles[0] = '<script>alert(1)</script>' }, 'angle brackets')
  })

  it('surfaces unavailable research or ambiguous series without importing guessed titles', async () => {
    const state = await prepared()
    const payload = { schemaVersion: 1, requestId: state.titles.requests[0].id, seriesId: 'a', language: 'en', status: 'needs_input', message: 'Please provide the official series link.' }
    await expect(store.importTitles('a', payload.requestId, JSON.stringify(payload), state.titles.revision)).rejects.toThrow('Please provide the official series link')
    expect((await store.openWorkspace('a')).titles.suggestions).toHaveLength(0)
  })
})

describe('manual title HTTP workflow', () => {
  it('prepares, imports and selects through the API, with server-owned series names and revisions', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/youtube', createYouTubeRouter({ store, seriesExists: async id => id === 'a', seriesTitle: async () => 'Server Series Name' }))
    server = createServer(app)
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/youtube/series`
    const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post(`${base}/missing/titles/prepare`, { expectedRevision: 0 })).status).toBe(404)
    expect((await post(`${base}/a/titles/prepare`, {})).status).toBe(409)
    const state = await (await post(`${base}/a/titles/prepare`, { expectedRevision: 0, seriesName: 'Untrusted name' })).json() as YouTubeWorkspace
    expect(state.titles.requests[0].seriesName).toBe('Server Series Name')
    const pasted = JSON.stringify(response(state), null, 2).replace(/^  /gm, '&#x20; ').replace(/\n/g, '\\\n').replace(/https:/g, 'https\\:')
    const importedResponse = await post(`${base}/a/titles/import`, { requestId: state.titles.requests[0].id, response: pasted, expectedRevision: state.titles.revision })
    expect(importedResponse.status).toBe(200)
    const imported = await importedResponse.json() as YouTubeWorkspace
    const selected = await post(`${base}/a/titles/selection`, { suggestionId: imported.titles.suggestions[0].id, expectedRevision: imported.titles.revision }, 'PUT')
    expect(selected.status).toBe(200)
    expect((await selected.json()).selectedTitle).toBe(five[0])
    expect((await post(`${base}/a/titles/selection`, { title: 'Another title', expectedRevision: 0 }, 'PUT')).status).toBe(409)
  })
})
