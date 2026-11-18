/**
 * Settings → AntiGravity (docs/PRD-antigravity-studio.md §4, §5, §9.1).
 *
 * Three tabs: AI Engines (engine picker for new runs, then the configuration
 * of only the selected engine — local Antigravity CLI, ChatGPT through the
 * Codex CLI, or Claude through Claude Code), Google Drive (Phase 1) and the
 * Prompt Pack (Phase 4). Shown as a tab of the Studio-wide Settings page; every
 * AntiGravity page links here through its top bar and Settings offers the way
 * back. The old /antigravity/settings address redirects here.
 */

import { useState } from 'react'
import { Cloud, FileText, Orbit, Workflow } from 'lucide-react'
import ClaudeCard from '@/components/antigravity/ClaudeCard'
import CodexCard from '@/components/antigravity/CodexCard'
import EngineCard from '@/components/antigravity/EngineCard'
import GoogleDriveCard from '@/components/antigravity/GoogleDriveCard'
import LocalAntigravityCard from '@/components/antigravity/LocalAntigravityCard'
import PromptPackCard from '@/components/antigravity/PromptPackCard'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AiEngine } from '@/lib/api'

export default function AntiGravitySettingsPanel() {
  const [engineRefresh, setEngineRefresh] = useState(0)
  const [engine, setEngine] = useState<AiEngine | null>(null)
  const bumpEngines = () => setEngineRefresh(n => n + 1)
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-xl font-semibold"><Orbit className="h-5 w-5" /> AntiGravity</h2>
        <p className="text-sm text-muted-foreground">
          Connect the Google Drive that receives page slices. Studio prepares and uploads pages; the chosen AI engine — the local Antigravity CLI, ChatGPT through Codex, or Claude through Claude Code — reads them through Studio's own tools. Each card saves on its own.
        </p>
      </header>
      <Tabs defaultValue="engines" className="space-y-4">
        <TabsList>
          <TabsTrigger value="engines" className="gap-1.5"><Workflow className="h-4 w-4" /> AI Engines</TabsTrigger>
          <TabsTrigger value="drive" className="gap-1.5"><Cloud className="h-4 w-4" /> Google Drive</TabsTrigger>
          <TabsTrigger value="prompts" className="gap-1.5"><FileText className="h-4 w-4" /> Prompt Pack</TabsTrigger>
        </TabsList>
        <TabsContent value="engines" className="mt-0 space-y-6">
          <EngineCard refreshKey={engineRefresh} onEngineChange={setEngine} />
          {engine === 'antigravity' && <LocalAntigravityCard />}
          {engine === 'codex' && <CodexCard onChange={bumpEngines} />}
          {engine === 'claude' && <ClaudeCard onChange={bumpEngines} />}
        </TabsContent>
        <TabsContent value="drive" className="mt-0">
          <GoogleDriveCard />
        </TabsContent>
        <TabsContent value="prompts" className="mt-0">
          <PromptPackCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
