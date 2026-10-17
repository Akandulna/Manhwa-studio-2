import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { settingsApi, Settings as SettingsType } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { useTheme, type Theme } from '@/lib/theme'
import { DocHistoryDialog, DocHistoryButton } from '@/components/settings/DocHistoryDialog'
import { CloudflareTab } from '@/components/settings/CloudflareR2Card'
import { archiveVersion, readHistory, type DocVersion } from '@/lib/docHistory'
import { loadSavedEditorPrompt, phoneEditorApi } from '@/pages/editor2/phoneEditor'
import StorageManager from '@/pages/storage/StorageManager'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Save, RotateCcw, FolderOpen, Gauge, UserCircle, ImageIcon, Download, Wand2, FileText, Film, Moon, Sun, Monitor, Palette, Cloud, HardDrive } from 'lucide-react'

// Vertical sidebar tab: full-width, left-aligned, active state as a muted pill.
const settingsTabTrigger =
  'w-full justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted data-[state=active]:shadow-none'

export default function Settings() {
  const { toast } = useToast()
  // ?tab=<value> deep-links to a tab (e.g. Clipper 3.0's "add your API key" link).
  const [searchParams] = useSearchParams()
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [settings, setSettings] = useState<SettingsType | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      setSettings(await settingsApi.getAll())
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load settings',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const updateSetting = (key: keyof SettingsType, value: string) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
  }

  const handleSave = async () => {
    if (!settings) return
    
    setSaving(true)
    
    try {
      // The response also contains independently edited documents and job state.
      // Saving general preferences must not write stale copies of those back.
      const { downloadRoot, concurrency, requestDelayMs, userAgent, minImageWidth, minAspectRatio } = settings
      await settingsApi.updateAll({ downloadRoot, concurrency, requestDelayMs, userAgent, minImageWidth, minAspectRatio })
      toast({
        title: 'Settings saved',
        description: 'Your settings have been updated. Restart the server for some changes to take effect.'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save settings',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }
  
  const handleReset = async () => {
    if (!confirm('Reset all settings to defaults?')) return
    
    try {
      const defaults = await settingsApi.reset()
      setSettings(defaults)
      toast({
        title: 'Settings reset',
        description: 'All settings have been reset to defaults'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to reset settings',
        variant: 'destructive'
      })
    }
  }
  
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }
  
  if (!settings) {
    return (
      <div className="p-6 text-center">
        <p>Failed to load settings</p>
      </div>
    )
  }
  
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-6 border-b">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div>
            <h1 className="text-3xl font-bold">Settings</h1>
            <p className="text-muted-foreground">
              Appearance, downloads, the Editor 2.0 prompt, Cloudflare and storage
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleReset}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Reset
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 min-h-0">
        <Tabs
          defaultValue={searchParams.get('tab') || 'appearance'}
          orientation="vertical"
          className="flex w-full h-full"
        >
          <TabsList className="h-full w-60 shrink-0 flex-col items-stretch justify-start gap-1 overflow-y-auto rounded-none border-r bg-background p-3">
            <TabsTrigger value="appearance" className={settingsTabTrigger}>
              <Palette className="h-4 w-4" />
              <span>Appearance</span>
            </TabsTrigger>
            <TabsTrigger value="download" className={settingsTabTrigger}>
              <Download className="h-4 w-4" />
              <span>Download & Performance</span>
            </TabsTrigger>
            <TabsTrigger value="editor2" className={settingsTabTrigger}>
              <Film className="h-4 w-4" />
              <span>Editor 2.0</span>
            </TabsTrigger>
            <TabsTrigger value="cloudflare" className={settingsTabTrigger}>
              <Cloud className="h-4 w-4" />
              <span>Cloudflare</span>
            </TabsTrigger>
            <TabsTrigger value="storage" className={settingsTabTrigger}>
              <HardDrive className="h-4 w-4" />
              <span>Storage</span>
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 min-w-0 overflow-auto">
          {/* Appearance Tab */}
          <TabsContent value="appearance" className="mt-0 p-6 max-w-4xl space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Palette className="h-5 w-5" />
                  Appearance
                </CardTitle>
                <CardDescription>
                  Choose how Manhwa Studio looks. Saved to this browser.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Quick dark-mode switch */}
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="darkMode" className="flex items-center gap-2">
                      {resolvedTheme === 'dark'
                        ? <Moon className="h-4 w-4" />
                        : <Sun className="h-4 w-4" />}
                      Dark Mode
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {theme === 'system'
                        ? `Following your system setting (currently ${resolvedTheme}).`
                        : `Dark mode is ${resolvedTheme === 'dark' ? 'on' : 'off'}.`}
                    </p>
                  </div>
                  <Switch
                    id="darkMode"
                    checked={resolvedTheme === 'dark'}
                    onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
                  />
                </div>

                <Separator />

                {/* Explicit three-way choice */}
                <div className="space-y-3">
                  <Label>Theme</Label>
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      { value: 'light', label: 'Light', icon: Sun },
                      { value: 'dark', label: 'Dark', icon: Moon },
                      { value: 'system', label: 'System', icon: Monitor },
                    ] as { value: Theme; label: string; icon: typeof Sun }[]).map(opt => {
                      const Icon = opt.icon
                      const active = theme === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setTheme(opt.value)}
                          aria-pressed={active}
                          className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors ${
                            active
                              ? 'border-primary bg-accent'
                              : 'border-border hover:bg-accent/50'
                          }`}
                        >
                          <Icon className="h-5 w-5" />
                          <span className="text-sm font-medium">{opt.label}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    "System" follows your OS appearance and updates automatically when it changes.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Download & Performance Tab */}
          <TabsContent value="download" className="mt-0 p-6 max-w-4xl space-y-6">
            {/* Download settings */}
            <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            Download Settings
          </CardTitle>
          <CardDescription>
            Configure where and how files are downloaded
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="downloadRoot">Download Root Folder</Label>
            <Input
              id="downloadRoot"
              value={settings.downloadRoot}
              onChange={(e) => updateSetting('downloadRoot', e.target.value)}
              placeholder="./downloads"
            />
            <p className="text-xs text-muted-foreground">
              All series will be downloaded under this folder. Can also be set via DOWNLOAD_ROOT env var.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Performance settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5" />
            Performance
          </CardTitle>
          <CardDescription>
            Control download speed and resource usage
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="concurrency">Max Concurrent Downloads</Label>
            <Input
              id="concurrency"
              type="number"
              min="1"
              max="10"
              value={settings.concurrency}
              onChange={(e) => updateSetting('concurrency', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How many images to download at once (1-10). Higher values are faster but may trigger rate limits.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="requestDelay">Request Delay (ms)</Label>
            <Input
              id="requestDelay"
              type="number"
              min="0"
              max="5000"
              value={settings.requestDelayMs}
              onChange={(e) => updateSetting('requestDelayMs', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Delay between image downloads in milliseconds. Helps avoid rate limiting.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Request settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCircle className="h-5 w-5" />
            Request Headers
          </CardTitle>
          <CardDescription>
            Configure how requests appear to servers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="userAgent">User Agent</Label>
            <Input
              id="userAgent"
              value={settings.userAgent}
              onChange={(e) => updateSetting('userAgent', e.target.value)}
              placeholder="Mozilla/5.0..."
            />
            <p className="text-xs text-muted-foreground">
              Browser user agent string sent with requests. Some CDNs require a valid browser UA.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Image filtering */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            Image Detection
          </CardTitle>
          <CardDescription>
            Control which images are detected as manhwa pages
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="minWidth">Minimum Image Width (px)</Label>
            <Input
              id="minWidth"
              type="number"
              min="100"
              max="1000"
              value={settings.minImageWidth}
              onChange={(e) => updateSetting('minImageWidth', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Images narrower than this will be ignored (helps filter icons/thumbnails).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="minAspect">Minimum Aspect Ratio (height/width)</Label>
            <Input
              id="minAspect"
              type="number"
              min="0.1"
              max="3"
              step="0.1"
              value={settings.minAspectRatio}
              onChange={(e) => updateSetting('minAspectRatio', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Images with lower aspect ratios will be ignored unless they meet the minimum width.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/50">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> DOWNLOAD_ROOT and CONCURRENCY can also be set via environment variables in your .env file. Environment variables take precedence over database settings.
          </p>
        </CardContent>
      </Card>
          </TabsContent>

          {/* Storage Tab — what each manhwa holds on disk, and cleaning it up */}
          <TabsContent value="storage" className="mt-0">
            <StorageManager libraryRoot={settings.downloadRoot} />
          </TabsContent>

          {/* Editor 2.0 Tab — Module 4v2 (video compile/timeline/render workspace) */}
          <TabsContent value="editor2" className="mt-0 p-6 max-w-4xl space-y-6">
      <Editor2PromptCard />
          </TabsContent>

          {/* Cloudflare Tab — R2 credentials for the Library's "Send to phone" */}
          <TabsContent value="cloudflare" className="mt-0 p-6 max-w-4xl space-y-6">
            <CloudflareTab />
          </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  )
}

// Browser cache and history key. Saves also retain the prompt on the server
// and put it in R2 for the Sleeper-Cell phone (phoneEditor.ts).
const EDITOR2_PROMPT_KEY = 'editor2.prompt'

/**
 * Editor 2.0 prompt editor. View/Edit/Save — the field is read-only until
 * "Edit" is pressed, so pasting a replacement can't clobber the saved prompt
 * by accident.
 *
 * Saved to the browser's localStorage so it survives a page refresh without
 * needing a server round-trip, and sent to R2 for the phone's Editor 2.0 run.
 */
function Editor2PromptCard() {
  const { toast } = useToast()
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [historyCount, setHistoryCount] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EDITOR2_PROMPT_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { content: string; savedAt: string }
        setContent(parsed.content)
        setSavedAt(parsed.savedAt)
      }
    } catch {
      // ignore corrupt/missing local state
    }
    let cancelled = false
    void loadSavedEditorPrompt().then(text => {
      if (cancelled) return
      setContent(text)
    }).catch(error => {
      if (!cancelled) toast({ title: 'Could not load Editor prompt', description: error instanceof Error ? error.message : 'Check the server connection.', variant: 'destructive' })
    })
    setHistoryCount(readHistory(EDITOR2_PROMPT_KEY).length)
    return () => { cancelled = true }
  }, [])

  const startEdit = () => { setDraft(content); setEditing(true) }
  const cancelEdit = () => setEditing(false)

  const save = () => {
    if (!draft.trim()) {
      toast({ title: 'Prompt is empty', description: 'Enter the Editor instructions before saving.', variant: 'destructive' })
      return
    }
    const savedAtIso = new Date().toISOString()
    try {
      // Archive first: archiveVersion no-ops on unchanged text, so re-saving
      // without edits does not pile up duplicate versions.
      setHistoryCount(archiveVersion(EDITOR2_PROMPT_KEY, { content, savedAt }).length)
      localStorage.setItem(EDITOR2_PROMPT_KEY, JSON.stringify({ content: draft, savedAt: savedAtIso }))
      setContent(draft)
      setSavedAt(savedAtIso)
      setEditing(false)
      void sendToPhone(draft, 'Prompt saved')
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Could not save to local storage', variant: 'destructive' })
    }
  }

  /**
   * Puts the prompt in R2 for the phone. The local save already stands, so a
   * failure here only says the phone didn't get it; the next save or Send to
   * phone sends it again.
   */
  const sendToPhone = async (text: string, title: string, note?: string) => {
    const lead = note ? `${note} ` : ''
    if (!text.trim()) {
      toast({ title, description: `${lead}Saved locally in this browser.` })
      return
    }
    try {
      const { phoneNotified } = await phoneEditorApi.savePrompt(text)
      toast({
        title,
        description: `${lead}Saved in this browser and sent to R2 for the phone` +
          (phoneNotified ? ', which picks it up now if it is open.' : '; the phone gets it on its next check.')
      })
    } catch (err) {
      toast({
        title,
        description: `${lead}Saved in this browser, but not sent to the phone: ${err instanceof Error ? err.message : 'R2 failed'}.`,
        variant: 'destructive'
      })
    }
  }

  /** Append-only restore: the live prompt is archived, then replaced. */
  const restoreVersion = (version: DocVersion) => {
    const savedAtIso = new Date().toISOString()
    try {
      archiveVersion(EDITOR2_PROMPT_KEY, { content, savedAt, restoredFrom: version.id })
      localStorage.setItem(EDITOR2_PROMPT_KEY, JSON.stringify({ content: version.content, savedAt: savedAtIso }))
      setContent(version.content)
      setSavedAt(savedAtIso)
      setEditing(false)
      setHistoryCount(readHistory(EDITOR2_PROMPT_KEY).length)
      void sendToPhone(version.content, 'Prompt restored', `Restored the version saved ${new Date(version.savedAt).toLocaleString()}.`)
    } catch (err) {
      toast({ title: 'Restore failed', description: err instanceof Error ? err.message : 'Could not save to local storage', variant: 'destructive' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Prompt
        </CardTitle>
        <CardDescription>
          The instructions used by Editor 2.0. Saved in Manhwa Studio and this browser, and sent to R2 for the phone’s Editor run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <>
            <Label htmlFor="editor2Prompt">Prompt</Label>
            <Textarea
              id="editor2Prompt"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Paste the Editor 2.0 prompt here…"
              className="font-mono text-xs min-h-[320px]"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button onClick={save} disabled={!draft.trim()}>
                <Save className="h-4 w-4 mr-2" />
                Save Prompt
              </Button>
              <Button variant="outline" onClick={cancelEdit}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            {savedAt && (
              <p className="text-xs text-muted-foreground">
                Last saved {new Date(savedAt).toLocaleString()}
              </p>
            )}
            <Textarea
              value={content}
              readOnly
              className="font-mono text-xs min-h-[320px] bg-muted/40"
              placeholder="No prompt saved yet."
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={startEdit}>
                <Wand2 className="h-4 w-4 mr-2" />
                Edit
              </Button>
              <DocHistoryButton count={historyCount} onClick={() => setHistoryOpen(true)} />
            </div>
          </>
        )}

        <DocHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          docKey={EDITOR2_PROMPT_KEY}
          title="Editor 2.0 prompt"
          currentContent={content}
          onRestore={restoreVersion}
        />
      </CardContent>
    </Card>
  )
}
