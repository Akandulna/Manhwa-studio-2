/**
 * CandidateOverlay — ChatGPT's imported crop candidates drawn on the ORIGINAL
 * page, read-only.
 *
 * This is the import's alignment check: candidates arrive in integer pixels of
 * the unsliced page (the server already added each slice's offset), so each box
 * is placed as a plain percentage of the page's width and height. If a box
 * lands off its artwork here, the reply's measurements are wrong — nothing in
 * between rescales them.
 *
 * Editing comes later (review phase); this view only shows what was imported
 * and what needs a look: boxes with review flags or import warnings are drawn
 * amber, seam-crossing boxes say so.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle } from 'lucide-react'
import { clipperApi, type Clipper3ImportedAnalysis, type Clipper3ImportIssue } from '@/lib/api'

const ACCENT = '#a855f7'
const FLAGGED = '#f59e0b'
const SELECTED = '#facc15'

interface CandidateOverlayProps {
  chapterId: string
  filename: string
  analysis: Clipper3ImportedAnalysis
  /** Width the page is drawn at, in CSS px. */
  pageWidth: number
}

export function CandidateOverlay({ chapterId, filename, analysis, pageWidth }: CandidateOverlayProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const boxRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const { source_width: W, source_height: H, candidates } = analysis
  const pageHeight = (pageWidth * H) / W

  const warningsById = useMemo(() => {
    const map: Record<string, Clipper3ImportIssue[]> = {}
    for (const warning of analysis.warnings) {
      if (!warning.candidateId) continue
      ;(map[warning.candidateId] ??= []).push(warning)
    }
    return map
  }, [analysis.warnings])

  const pageWarnings = analysis.warnings.filter(w => !w.candidateId)

  useEffect(() => {
    if (!selected) return
    boxRefs.current[selected]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    rowRefs.current[selected]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])

  const needsLook = (id: string) => {
    const c = candidates.find(x => x.candidate_id === id)
    return !!c && (c.review_flags.length > 0 || c.unknown_flags.length > 0 || (warningsById[id]?.length ?? 0) > 0)
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Media viewport: dark in both themes, like every page viewer here. */}
      <div className="flex-shrink-0 overflow-auto rounded border bg-neutral-900" style={{ width: pageWidth + 18 }}>
        <div className="relative" style={{ width: pageWidth, height: pageHeight }}>
          <img
            src={clipperApi.getImageUrl(chapterId, filename)}
            alt={filename}
            draggable={false}
            className="absolute inset-0 w-full h-full select-none"
          />
          {candidates.map((c, i) => {
            const color = selected === c.candidate_id ? SELECTED : needsLook(c.candidate_id) ? FLAGGED : ACCENT
            return (
              <div
                key={c.candidate_id}
                ref={el => { boxRefs.current[c.candidate_id] = el }}
                onClick={() => setSelected(c.candidate_id)}
                className="absolute cursor-pointer"
                style={{
                  left: `${(c.bounds.x0 / W) * 100}%`,
                  top: `${(c.bounds.y0 / H) * 100}%`,
                  width: `${((c.bounds.x1 - c.bounds.x0) / W) * 100}%`,
                  height: `${((c.bounds.y1 - c.bounds.y0) / H) * 100}%`,
                  border: `2px solid ${color}`,
                  background: selected === c.candidate_id ? 'rgba(250, 204, 21, 0.12)' : 'transparent'
                }}
              >
                <span
                  className="absolute left-0 top-0 px-1 text-[11px] font-mono font-semibold text-black"
                  style={{ background: color }}
                >
                  {i + 1}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto pr-1 space-y-2">
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            {candidates.length} candidate{candidates.length === 1 ? '' : 's'} on {W}×{H} px ·
            imported {new Date(analysis.imported_at).toLocaleString()} · reply used{' '}
            <span className="font-mono">{analysis.reply_coordinate_system}</span>
          </p>
          {!analysis.page_inspection_complete && (
            <p className="text-amber-500">
              <AlertTriangle className="inline h-3 w-3 mr-1" />
              ChatGPT says it could not inspect the whole page.
            </p>
          )}
          {analysis.page_review_flags.map((flag, i) => (
            <p key={i} className="text-amber-500">
              <AlertTriangle className="inline h-3 w-3 mr-1" />
              Page flag: {flag}
            </p>
          ))}
          {pageWarnings.map((w, i) => (
            <p key={i} className="text-amber-500">
              <AlertTriangle className="inline h-3 w-3 mr-1" />
              {w.message}
            </p>
          ))}
        </div>

        {candidates.map((c, i) => {
          const warnings = warningsById[c.candidate_id] ?? []
          const isSelected = selected === c.candidate_id
          return (
            <button
              key={c.candidate_id}
              ref={el => { rowRefs.current[c.candidate_id] = el }}
              type="button"
              onClick={() => setSelected(c.candidate_id)}
              className={`w-full text-left rounded border p-2 transition-colors ${
                isSelected ? 'border-yellow-400 bg-yellow-400/10' : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs font-semibold w-6 flex-shrink-0">{i + 1}</span>
                <span className="font-mono text-xs truncate flex-1">{c.reason || '(no reason)'}</span>
                <span className="font-mono text-[11px] text-muted-foreground flex-shrink-0">
                  {c.bounds.x1 - c.bounds.x0}×{c.bounds.y1 - c.bounds.y0}
                </span>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground pl-8">
                ({c.bounds.x0}, {c.bounds.y0}) → ({c.bounds.x1}, {c.bounds.y1})
                {c.slices.length > 1 && ` · crosses ${c.slices.join(' / ')}`}
              </p>
              {c.description && <p className="text-xs pl-8 mt-1">{c.description}</p>}
              {(c.review_flags.length > 0 || c.unknown_flags.length > 0) && (
                <div className="flex flex-wrap gap-1 pl-8 mt-1">
                  {c.review_flags.map(flag => (
                    <Badge key={flag} variant="outline" className="text-[10px] border-amber-500 text-amber-500">
                      {flag}
                    </Badge>
                  ))}
                  {c.unknown_flags.map(flag => (
                    <Badge key={flag} variant="outline" className="text-[10px] text-muted-foreground" title="Not in the flag vocabulary — note only">
                      {flag}?
                    </Badge>
                  ))}
                </div>
              )}
              {warnings.map((w, j) => (
                <p key={j} className="text-[11px] text-amber-500 pl-8 mt-1">
                  <AlertTriangle className="inline h-3 w-3 mr-1" />
                  {w.message}
                </p>
              ))}
            </button>
          )
        })}
      </div>
    </div>
  )
}
