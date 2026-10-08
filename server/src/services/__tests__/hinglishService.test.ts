import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// One chapter with an English script on disk; the Hindi row is whatever the conversion writes.
let root: string
let hindiRow: any = null
const upserts: any[] = []
vi.mock('../../index.js', () => ({
  prisma: {
    chapter: {
      findUniqueOrThrow: async () => ({
        id: 'c1',
        number: 3,
        folderPath: 'Solo Hero/Chapter 003',
        scripts: [{
          language: 'en',
          status: 'done',
          isPartEnd: true,
          scriptPath: path.join(root, 'Solo Hero/Chapter 003/script.md'),
          rollingSummary: 'The story so far.'
        }]
      })
    },
    chapterScript: {
      findUnique: async () => hindiRow,
      upsert: async ({ create, update }: any) => {
        upserts.push({ create, update })
        hindiRow = hindiRow ? { ...hindiRow, ...update } : { ...create }
        return hindiRow
      }
    },
    setting: { findUnique: async () => null }
  }
}))
vi.mock('../storageService.js', () => ({ getPublishedChapters: async () => ({ chapters: {} }) }))

// Gemini, answering from a script of replies; every call's turns are kept.
let replies: string[] = []
const calls: { role: string; text: string }[][] = []
vi.mock('../ai/index.js', () => ({
  aiProviderFactory: {
    getDefaultProvider: () => ({
      name: 'gemini',
      model: 'gemini-test',
      chat: async ({ turns }: { turns: { role: string; text: string }[] }) => {
        calls.push(turns)
        return { text: replies.shift() ?? '', tokensUsed: 100 }
      }
    })
  }
}))

const { HinglishConversionService } = await import('../hinglishService.js')
const { buildFollowUp, buildWritePrompt, sourceSha256 } = await import('../hinglishConvert.js')

const ENGLISH = 'Jin walks into the gate and slowly looks around the dark hall.\n\nThe boss wakes up.'
const words = (n: number) => Array.from({ length: n }, () => 'शब्द').join(' ')
const io = { emit: vi.fn() } as any

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hinglish-'))
  process.env.DOWNLOAD_ROOT = root
  await fs.mkdir(path.join(root, 'Solo Hero/Chapter 003'), { recursive: true })
  await fs.writeFile(path.join(root, 'Solo Hero/Chapter 003/script.md'), ENGLISH + '\n')
  hindiRow = null
  upserts.length = 0
  calls.length = 0
  replies = []
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const NOTES = '===SCENES===\n[SCENE 1: P1-P2]\n- जिन गेट में जाता है, बॉस जागता है'

describe('HinglishConversionService.convertChapter', () => {
  it('asks for scene notes, then the narration in the same conversation, and saves a reply that passes', async () => {
    replies = [NOTES, `===SCRIPT===\n[SCENE 1: P1-P2]\n${words(12)}\n\nबॉस जाग गया।\n\n===SUMMARY===\nअब तक की कहानी।`]
    const result = await new HinglishConversionService(io).convertChapter('c1')
    expect(result).toEqual({ success: true, state: 'done', issues: [] })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toHaveLength(1)
    expect(calls[0][0].text).toContain('ENGLISH SCRIPT (2 paragraphs):\n[P1] Jin walks')
    expect(calls[1].map(t => t.role)).toEqual(['user', 'model', 'user'])
    expect(calls[1][1].text).toBe(NOTES)
    expect(calls[1][2].text).toBe(buildWritePrompt(2, true))

    const saved = await fs.readFile(path.join(root, 'Solo Hero/Chapter 003/script.hi.md'), 'utf-8')
    expect(saved).toBe(`${words(12)}\n\nबॉस जाग गया।`)
    expect(hindiRow).toMatchObject({
      language: 'hi',
      status: 'done',
      isPartEnd: true,
      closingParagraph: 'बॉस जाग गया।',
      rollingSummary: 'अब तक की कहानी।',
      sourceSha256: sourceSha256(ENGLISH),
      review: null,
      model: 'gemini-test'
    })
  })

  it('retries once in the same conversation, then saves for review when it still fails', async () => {
    const first = `===SCRIPT===\n[SCENE 1: P1]\n${words(3)}\n===SUMMARY===\nस।`
    replies = [NOTES, first, `===SCRIPT===\n[SCENE 1: P1]\n${words(12)}\n===SUMMARY===\nस।`]
    const result = await new HinglishConversionService(io).convertChapter('c1')

    const firstIssues = ['Missing paragraphs: P2', 'Too short: P1 (3 words, the English has 12)', 'Too short overall: 3 words, it needs at least 14 (the English has 16)']
    expect(calls).toHaveLength(3)
    expect(calls[2].map(t => t.role)).toEqual(['user', 'model', 'user', 'model', 'user'])
    expect(calls[2][3].text).toBe(first)
    expect(calls[2][4].text).toBe(buildFollowUp(firstIssues, 2, true))

    const secondIssues = ['Missing paragraphs: P2', 'Too short overall: 12 words, it needs at least 14 (the English has 16)']
    expect(result).toEqual({ success: true, state: 'review', issues: secondIssues })
    expect(hindiRow).toMatchObject({ status: 'done', review: JSON.stringify(secondIssues), closingParagraph: words(12) })
  })

  it('fails without touching an earlier Hindi script when no reply has scenes', async () => {
    hindiRow = { language: 'hi', status: 'done', scriptPath: '/old/script.hi.md', sourceSha256: 'old' }
    replies = [NOTES, 'Sorry, I cannot help with that.', 'Still no.']
    const result = await new HinglishConversionService(io).convertChapter('c1')
    expect(result).toEqual({ success: false, error: 'The Hinglish reply had no [SCENE n: Px-Py] scenes to save' })
    expect(hindiRow).toMatchObject({ status: 'done', scriptPath: '/old/script.hi.md', sourceSha256: 'old' })
    expect(hindiRow.error).toMatch(/no \[SCENE/)
    await expect(fs.access(path.join(root, 'Solo Hero/Chapter 003/script.hi.md'))).rejects.toThrow()
  })

  it('stops at step 1 when the scene notes come back empty', async () => {
    replies = ['  ']
    const result = await new HinglishConversionService(io).convertChapter('c1')
    expect(result).toEqual({ success: false, error: 'The scene notes reply (step 1) was empty' })
    expect(calls).toHaveLength(1)
  })
})
