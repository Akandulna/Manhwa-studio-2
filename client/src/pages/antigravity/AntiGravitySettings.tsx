/**
 * Settings → AntiGravity (docs/PRD-antigravity-studio.md §4, §5, §9.1).
 *
 * Google Drive (Phase 1), the AI engine for new runs, the local Antigravity
 * CLI (Phase 2), ChatGPT through the Codex CLI (second engine) and the prompt
 * pack (Phase 4). Shown as a tab of the Studio-wide Settings page; every
 * AntiGravity page links here through its top bar and Settings offers the way
 * back. The old /antigravity/settings address redirects here.
 */

import { useState } from 'react'
import { Orbit } from 'lucide-react'
import CodexCard from '@/components/antigravity/CodexCard'
import EngineCard from '@/components/antigravity/EngineCard'
import GoogleDriveCard from '@/components/antigravity/GoogleDriveCard'
import LocalAntigravityCard from '@/components/antigravity/LocalAntigravityCard'
import PromptPackCard from '@/components/antigravity/PromptPackCard'

export default function AntiGravitySettingsPanel() {
  const [engineRefresh, setEngineRefresh] = useState(0)
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-xl font-semibold"><Orbit className="h-5 w-5" /> AntiGravity</h2>
        <p className="text-sm text-muted-foreground">
          Connect the Google Drive that receives page slices. Studio prepares and uploads pages; the chosen AI engine — the local Antigravity CLI or ChatGPT through Codex — reads them through Studio's own tools. Each card saves on its own.
        </p>
      </header>
      <GoogleDriveCard />
      <EngineCard refreshKey={engineRefresh} />
      <LocalAntigravityCard />
      <CodexCard onChange={() => setEngineRefresh(n => n + 1)} />
      <PromptPackCard />
    </div>
  )
}
