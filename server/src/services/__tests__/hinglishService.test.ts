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
const { buildFollowUp, sourceSha256 } = await import('../hinglishConvert.js')

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

describe('HinglishConversionService.convertChapter', () => {
  it('saves a reply that passes, with closing, summary and the English source hash', async () => {
    replies = [`===SCRIPT===\n[P1] ${words(12)}\n\n[P2] बॉस जाग गया।\n\n===SUMMARY===\nअब तक की कहानी।`]
    const result = await new HinglishConversionService(io).convertChapter('c1')
    expect(result).toEqual({ success: true, state: 'done', issues: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0][0].text).toContain('ENGLISH SCRIPT (2 paragraphs):\n[P1] Jin walks')

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
    const first = `===SCRIPT===\n[P1] ${words(3)}\n===SUMMARY===\nस।`
    replies = [first, `===SCRIPT===\n[P1] ${words(12)}\n===SUMMARY===\nस।`]
    const result = await new HinglishConversionService(io).convertChapter('c1')

    const firstIssues = ['Missing paragraphs: P2', 'Too short: P1 (3 words, the English has 12)', 'Too short overall: 3 words, it needs at least 14 (the English has 16)']
    expect(calls).toHaveLength(2)
    expect(calls[1].map(t => t.role)).toEqual(['user', 'model', 'user'])
    expect(calls[1][1].text).toBe(first)
    expect(calls[1][2].text).toBe(buildFollowUp(firstIssues, 2))

    const secondIssues = ['Missing paragraphs: P2', 'Too short overall: 12 words, it needs at least 14 (the English has 16)']
    expect(result).toEqual({ success: true, state: 'review', issues: secondIssues })
    expect(hindiRow).toMatchObject({ status: 'done', review: JSON.stringify(secondIssues), closingParagraph: words(12) })
  })

  it('fails without touching an earlier Hindi script when no reply has paragraphs', async () => {
    hindiRow = { language: 'hi', status: 'done', scriptPath: '/old/script.hi.md', sourceSha256: 'old' }
    replies = ['Sorry, I cannot help with that.', 'Still no.']
    const result = await new HinglishConversionService(io).convertChapter('c1')
    expect(result).toEqual({ success: false, error: 'The Hinglish reply had no [P1]..[P2] paragraphs to save' })
    expect(hindiRow).toMatchObject({ status: 'done', scriptPath: '/old/script.hi.md', sourceSha256: 'old' })
    expect(hindiRow.error).toMatch(/no \[P1\]/)
    await expect(fs.access(path.join(root, 'Solo Hero/Chapter 003/script.hi.md'))).rejects.toThrow()
  })
})
