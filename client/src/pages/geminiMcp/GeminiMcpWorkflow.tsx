/**
 * Gemini MCP → one series' workflow graph (docs/PRD-gemini-app-narration.md §5). The same flow as Run automation
 * and AntiGravity; only Narration Studio runs through the Gemini app for now, every other node is disabled.
 */

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Clapperboard, Mic, PenLine, Scissors } from 'lucide-react'
import { geminiMcpApi, type PhoneRunKind } from '@/lib/api'
import { AutomationFlow } from '../sleeper/RunAutomation'
import { GeminiMcpCrumbs } from '@/components/geminiMcp/GeminiMcpShared'

const NODES: Record<PhoneRunKind, { label: string; does: string; icon: typeof Mic; active: boolean }> = {
  narration: { label: 'Narration Studio', does: 'English and Hinglish scripts, written in the Gemini app from the chapter’s pages', icon: PenLine, active: true },
  voiceover: { label: 'Voiceover', does: 'Voices every split without audio', icon: Mic, active: false },
  clipper: { label: 'Image Clipper', does: 'Crops every page', icon: Scissors, active: false },
  metadata: { label: 'Metadata', does: 'Crop descriptions and English-script links', icon: PenLine, active: false },
  editor: { label: 'Timeline', does: 'Editor 2.0 timelines', icon: Clapperboard, active: false }
}

export default function GeminiMcpWorkflow() {
  const { seriesId = '' } = useParams()
  const [title, setTitle] = useState('Series')
  useEffect(() => { geminiMcpApi.chapters(seriesId).then(r => setTitle(r.series.title)).catch(() => undefined) }, [seriesId])

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <GeminiMcpCrumbs crumbs={[{ label: 'Gemini MCP', to: '/gemini-mcp' }, { label: title }]} />
      <header>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">Choose a module. Narration Studio runs through the Gemini app; the others come later.</p>
      </header>
      <div className="max-w-3xl" aria-label="Workflow">
        <AutomationFlow card={kind => {
          const node = NODES[kind]
          const body = (
            <>
              <span className="flex items-center gap-2 font-medium"><node.icon className="h-4 w-4 text-muted-foreground" aria-hidden /> {node.label}</span>
              <span className="text-sm text-muted-foreground">{node.does}</span>
              <span className={node.active ? 'mt-auto pt-1 text-xs font-medium text-primary' : 'mt-auto pt-1 text-xs text-muted-foreground'}>{node.active ? 'Open · Gemini app' : 'Coming Soon'}</span>
            </>
          )
          return node.active ? (
            <Link key={kind} to={`/gemini-mcp/series/${seriesId}/narration`} aria-label={`${node.label}: open`}
              className="flex h-full flex-col gap-1.5 rounded-lg border-2 border-primary bg-primary/10 p-4 text-left transition-colors hover:bg-primary/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {body}
            </Link>
          ) : (
            <div key={kind} aria-disabled="true" aria-label={`${node.label}: coming soon`} title="Coming Soon"
              className="flex h-full cursor-not-allowed flex-col gap-1.5 rounded-lg border border-dashed p-4 text-left opacity-60">
              {body}
            </div>
          )
        }} />
      </div>
    </div>
  )
}
