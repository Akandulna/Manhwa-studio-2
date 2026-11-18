import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ClipboardPaste, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function PromptActions({ copied, pasted, disabled, onCopy, onPaste, onFallback }: { copied: boolean; pasted: boolean; disabled: boolean; onCopy: () => Promise<void>; onPaste: (text: string) => void; onFallback: () => void }) {
  const [reading, setReading] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function paste() {
    setReading(true)
    try {
      const text = await navigator.clipboard.readText()
      if (!mounted.current) return
      if (text.trim() && text.length <= 100000) onPaste(text)
      else onFallback()
    } catch { if (mounted.current) onFallback() }
    finally { if (mounted.current) setReading(false) }
  }
  return <div className="space-y-3"><div role="group" aria-label="Prompt and response actions" className="grid grid-cols-2 gap-2">
    <Button className="px-1 text-xs sm:px-4 sm:text-sm" disabled={disabled || reading} onClick={() => void onCopy()}><Copy className="mr-2 hidden h-4 w-4 shrink-0 sm:block" />Copy prompt{copied && <Check aria-label="Prompt copied" className="ml-1 h-3 w-3 shrink-0 sm:ml-2 sm:h-4 sm:w-4" />}</Button>
    <Button className="px-1 text-xs sm:px-4 sm:text-sm" variant="outline" disabled={disabled || reading} onClick={() => void paste()}><ClipboardPaste className="mr-2 hidden h-4 w-4 shrink-0 sm:block" />{reading ? 'Pasting…' : 'Paste response'}{pasted && <Check aria-label="Response pasted" className="ml-1 h-3 w-3 shrink-0 sm:ml-2 sm:h-4 sm:w-4 text-emerald-500" />}</Button>
  </div><a href="https://aistudio.google.com/prompts/new_chat" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">Open AI Studio<ExternalLink className="h-3 w-3" /></a></div>
}
