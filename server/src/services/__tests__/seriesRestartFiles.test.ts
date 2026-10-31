import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { archiveRestartFiles, chapterStoryLinksCurrent } from '../seriesRestartFiles.js'
import { restartRevision, sameRestart, restartCloudPrefixes, stripCropStory } from '../seriesRestartModel.js'
import { mergeControl, validControls } from '../libraryControlModel.js'

describe('series restart backup', () => {
  it('archives both languages, alignment and exports while preserving source, crop geometry and descriptions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'series-restart-'))
    try {
      const write = async (rel: string, text = rel) => { const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
      const moved = ['Hero/about.md','Hero/Chapter 001/script.md','Hero/Chapter 001/script.hi.md','Hero/Chapter 001/audio/a.wav','Hero/Chapter 001/audio_hi/a.wav','Hero/Chapter 001/script-timeline.md','Hero/Chapter 001/script-timeline.hi.md','Hero/_video2/ch001.mp4','Hero/Part 01 - full script.md']
      const retained = ['Hero/Chapter 001/page_001.jpg','Hero/Chapter 001/crop_points3/page_001.json','Hero/Chapter 001/crops3/crop.jpg','Other/Chapter 001/script.md']
      for (const file of [...moved,...retained]) await write(file)
      const metadata = JSON.stringify({ storyLinking: { scriptSha256: 'old' }, crops: [{ description: 'red coat', exportedFilename: 'crop.jpg', storyContext: 'old event', scriptRefs: ['P0001'], matchType: 'direct', evidence: 'coat', reviewReason: '' }] })
      const meta = 'Hero/Chapter 001/crop_metadata3/page_001.txt'
      await write(meta,metadata)
      const backup = await archiveRestartFiles(root,'Hero','123-nord',['Hero/Chapter 001'],{ scripts: 'original' })
      for (const file of moved) { expect(await fs.readFile(path.join(backup,'files',file),'utf8')).toBe(file); await expect(fs.stat(path.join(root,file))).rejects.toThrow() }
      for (const file of retained) expect(await fs.readFile(path.join(root,file),'utf8')).toBe(file)
      expect(await fs.readFile(path.join(backup,'metadata',meta),'utf8')).toBe(metadata)
      expect(JSON.parse(await fs.readFile(path.join(root,meta),'utf8'))).toEqual({ crops: [{ description:'red coat',exportedFilename:'crop.jpg' }] })
      await write('Hero/Chapter 001/script.md','new script')
      await archiveRestartFiles(root,'Hero','123-nord',['Hero/Chapter 001'],{ scripts: 'new' })
      expect(await fs.readFile(path.join(root,'Hero/Chapter 001/script.md'),'utf8')).toBe('new script')
      expect(JSON.parse(await fs.readFile(path.join(backup,'state.json'),'utf8'))).toEqual({scripts:'original'})
    } finally { await fs.rm(root,{ recursive:true,force:true }) }
  })
  it('keeps Editor blocked until current script associations exist, and ignores unmatched crops', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'restart-links-')),dir=path.join(root,'Hero/Chapter 001')
    try {
      await fs.mkdir(path.join(dir,'crop_metadata3'),{recursive:true})
      await fs.writeFile(path.join(dir,'script.md'),'New script.\n')
      const file=path.join(dir,'crop_metadata3/page_001.txt')
      const linked={storyLinking:{scriptSha256:createHash('sha256').update('New script.').digest('hex')},crops:[{matchType:'direct',scriptRefs:['P0001'],storyContext:'The new event.',evidence:'A visible action.',reviewReason:''},{matchType:'unmatched',scriptRefs:[],storyContext:'',reviewReason:'uncertain'}]}
      await fs.writeFile(file,JSON.stringify(linked))
      expect(await chapterStoryLinksCurrent(root,'Hero/Chapter 001')).toBe(true)
      await fs.writeFile(file,stripCropStory(JSON.stringify(linked)))
      expect(await chapterStoryLinksCurrent(root,'Hero/Chapter 001')).toBe(false)
    } finally {await fs.rm(root,{recursive:true,force:true})}
  })
  it('rejects paths outside the selected series before archiving anything', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'series-scope-'))
    try { await expect(archiveRestartFiles(root,'Hero','123-nord',['Other/Chapter 001'],{})).rejects.toThrow('outside this series') }
    finally { await fs.rm(root,{recursive:true,force:true}) }
  })
  it('keeps the newest generation and rejects old or unversioned work after a restart', () => {
    const first={folder:'Hero',restart:{at:10,deviceId:'nord',done:true}}
    const next={folder:'Hero',restart:{at:20,deviceId:'mac',done:true}}
    expect(restartRevision(mergeControl(next,first))).toBe('20-mac')
    expect(validControls([{...first,restart:{...first.restart,done:false}}])).toBe(false)
    expect(sameRestart('20-mac',undefined)).toBe(false)
    expect(sameRestart('20-mac','10-nord')).toBe(false)
    expect(sameRestart('20-mac','20-mac')).toBe(true)
    expect(sameRestart(null,null)).toBe(true)
    expect(sameRestart(null,'null')).toBe(true)
    const prefixes=restartCloudPrefixes(['Phone/',''],'Hero')
    expect(prefixes.some(p=>'Phone/manhwa/Hero/Chapter 001.zip'.startsWith(p))).toBe(false)
    expect(prefixes.some(p=>'Phone/crops/Hero/Chapter 001.zip'.startsWith(p))).toBe(false)
    expect(prefixes.some(p=>'Phone/scripts/Hero 2/Hero 2.zip'.startsWith(p))).toBe(false)
    expect(prefixes.some(p=>'Phone/scripts/Hero/Hero.hi.zip'.startsWith(p))).toBe(true)
    expect(stripCropStory('visual description')).toBe('visual description')
  })
})
