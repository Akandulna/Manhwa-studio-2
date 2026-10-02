/**
 * English / Hindi switcher shown at the top of Narration Studio and Editor 2.0.
 * Everything below it on the page belongs to the selected language.
 */

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { NarrationLanguage } from '@/lib/narrationLanguage'

export function LanguageTabs({
  value,
  onChange,
  disabled = false,
  className
}: {
  value: NarrationLanguage
  onChange: (language: NarrationLanguage) => void
  /** Locks the tabs, e.g. while a run that belongs to the current tab is in flight. */
  disabled?: boolean
  className?: string
}) {
  return (
    <Tabs value={value} onValueChange={v => onChange(v === 'hi' ? 'hi' : 'en')} className={className}>
      <TabsList>
        <TabsTrigger value="en" className="px-4" disabled={disabled}>English</TabsTrigger>
        <TabsTrigger value="hi" className="px-4" disabled={disabled}>
          Hindi <span className="ml-1.5 text-xs opacity-70" lang="hi">हिन्दी</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
