/**
 * "Write with Gemini" for one chapter and language, outside the Gemini MCP pages (Narration: chapters the phone
 * stopped on with "Prohibited content"). Prepares the chapter as a Gemini MCP job (docs/PRD-gemini-app-narration.md),
 * or reuses the one already going, and shows the prompt to paste into a new Gemini chat. The saved script clears
 * the phone's block like any local save.
 */

import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { geminiMcpApi, type GeminiJobView } from '@/lib/api'
import type { NarrationLanguage } from '@/lib/narrationLanguage'
import { PromptDialog } from './GeminiMcpShared'

export function GeminiProcessButton({ chapter, language, disabled }: {
  chapter: { id: string; number: number; hasScript: boolean }
  language: NarrationLanguage
  disabled?: boolean
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<{ job: GeminiJobView; prompt: string } | null>(null)
  const name = language === 'hi' ? 'Hinglish' : 'English'

  const start = async () => {
    if (chapter.hasScript && !window.confirm(`Chapter ${chapter.number} already has a ${name} script. Write a new one with Gemini? The current script stays until Gemini's is saved.`)) return
    setBusy(true)
    try {
      setShown(await geminiMcpApi.process({ chapterId: chapter.id, language, rewrite: chapter.hasScript }))
    } catch (e) {
      toast({ title: 'Could not prepare it for Gemini', description: (e as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={start} disabled={disabled || busy} title={`Write this chapter's ${name} script in the Gemini Mac app (Gemini MCP)`}>
        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Gemini
      </Button>
      {shown && (
        <PromptDialog
          open onOpenChange={o => { if (!o) setShown(null) }}
          title={`Chapter ${chapter.number} · ${name} · Gemini`}
          description={`Paste this into a new Gemini chat. Studio checks every step and saves the script like Replace. Progress shows under Gemini MCP → Narration Studio.${language === 'en' ? ' The pages upload to Google Drive first; you can paste right away.' : ''}`}
          prompt={shown.prompt}
          job={shown.job}
        />
      )}
    </>
  )
}
