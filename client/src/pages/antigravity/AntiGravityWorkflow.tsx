/**
 * AntiGravity → workflow for one part (PRD §6.3). A module navigator drawn as
 * the same flow as Run automation (AutomationFlow): Narration → Voiceover,
 * Image Clipper → Metadata, Voiceover → Metadata, and Voiceover and Metadata
 * both → Editor. Image Clipper, Metadata and Editor 2.0 timelines are active
 * (they run on this Mac through AntiGravity); the others are disabled "Coming
 * Soon" nodes and never trigger the existing automations.
 */

import { Link, Navigate, useParams } from 'react-router-dom'
import { Clapperboard, Mic, PenLine, Scissors } from 'lucide-react'
import type { PhoneRunKind } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AutomationFlow } from '../sleeper/RunAutomation'
import { AntiGravityTopBar, partRange, useSeriesScope } from './shared'

export const WORKFLOW_NODES: Record<PhoneRunKind, { label: string; does: string; icon: typeof Mic; active: boolean }> = {
  narration: { label: 'Narration scripts', does: 'Writes each chapter’s script, then its Hindi retelling', icon: PenLine, active: false },
  voiceover: { label: 'Voiceover', does: 'Voices every split without audio', icon: Mic, active: false },
  clipper: { label: 'Image Clipper', does: 'Crops every page left in this part', icon: Scissors, active: true },
  metadata: { label: 'Metadata', does: 'Creates descriptions and English-script links from reviewed crops', icon: PenLine, active: true },
  editor: { label: 'Editor 2.0 timelines', does: 'Makes each chapter’s timeline from its package', icon: Clapperboard, active: true }
}

/** Where an active node opens, under the part. */
const NODE_PATH: Partial<Record<PhoneRunKind, string>> = { clipper: 'image-clipper', metadata: 'metadata', editor: 'timeline' }

export default function AntiGravityWorkflow() {
  const { seriesId, partNumber } = useParams()
  const part = Number(partNumber)
  const scope = useSeriesScope(seriesId)
  if (!Number.isInteger(part) || part < 1) return <Navigate to={`/antigravity/series/${seriesId}`} replace />
  const { first, last } = partRange(part)
  const title = scope.series?.title ?? 'Series'

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <AntiGravityTopBar crumbs={[{ label: 'AntiGravity', to: '/antigravity' }, { label: title, to: `/antigravity/series/${seriesId}` }, { label: `Part ${part}` }]} />
      <header>
        <h1 className="text-2xl font-semibold">{title} · Part {part}</h1>
        <p className="text-sm text-muted-foreground">Chapters {first}–{last}. Choose a module. Image Clipper, Metadata and Editor 2.0 timelines run through AntiGravity.</p>
      </header>

      <div className="max-w-3xl" aria-label="Workflow">
        <AutomationFlow card={kind => {
          const node = WORKFLOW_NODES[kind]
          const body = (
            <>
              <span className="flex items-center gap-2 font-medium">
                <node.icon className="h-4 w-4 text-muted-foreground" aria-hidden /> {node.label}
              </span>
              <span className="text-sm text-muted-foreground">{node.does}</span>
              <span className={cn('mt-auto pt-1 text-xs', node.active ? 'font-medium text-primary' : 'text-muted-foreground')}>{node.active ? 'Open · AntiGravity' : 'Coming Soon'}</span>
            </>
          )
          return node.active ? (
            <Link
              key={kind}
              to={`/antigravity/series/${seriesId}/parts/${part}/${NODE_PATH[kind]}`}
              className="flex h-full flex-col gap-1.5 rounded-lg border-2 border-primary bg-primary/10 p-4 text-left transition-colors hover:bg-primary/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${node.label}: open`}
            >
              {body}
            </Link>
          ) : (
            <div
              key={kind}
              aria-disabled="true"
              aria-label={`${node.label}: coming soon`}
              title="Coming Soon"
              className="flex h-full cursor-not-allowed flex-col gap-1.5 rounded-lg border border-dashed p-4 text-left opacity-60"
            >
              {body}
            </div>
          )
        }} />
      </div>
      <p className="text-xs text-muted-foreground">
        The diagram is a navigator: Image Clipper does not wait for Narration or Voiceover. AntiGravity's Metadata runs on this Mac after human review, Crop Sections and the English script; its timelines run once Editor 2.0 has a chapter's voiceover, alignment and cut crops. Neither starts the phones' Metadata or Editor automation; saved timelines go to the phones through Editor 2.0.
      </p>
    </div>
  )
}
