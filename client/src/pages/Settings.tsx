import { useEffect, useState } from 'react'
import { settingsApi, Settings as SettingsType, narrationApi, AIStatus, aiCropApi, clipper2Api, voiceoverApi, visionApi, type VisionProviderInfo, type VisionProviderName } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { useTheme, type Theme } from '@/lib/theme'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Save, RotateCcw, FolderOpen, Gauge, UserCircle, ImageIcon, Wand2, Sparkles, CheckCircle, XCircle, Key, ExternalLink, Volume2, Mic, FileText, Download, Crop, Locate, Upload, Clock, Film, Moon, Sun, Monitor, Palette, Cpu, Cloud } from 'lucide-react'

// Extended settings type for Module 2 & 3
interface ExtendedSettings extends SettingsType {
  narrationBasePrompt?: string
  narrationImageMaxWidth?: string
  narrationSingleCallCap?: string
  narrationBatchSize?: string
  narrationSummaryLength?: string
  // AI Model settings
  aiScriptModel?: string
  aiSummaryModel?: string
  // TTS settings
  ttsProvider?: string
  ttsApiKey?: string
  ttsVoice?: string
  ttsKokoroVoice?: string
  ttsSpeed?: string
  ttsStylePrompt?: string
  ttsNormalizeText?: string
  // Narraitaion Studio prompts
  scriptWithTimestampPrompt?: string
}

// Available AI models
const GEMINI_MODELS = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Recommended)', description: 'Latest and fastest' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', description: 'Fast and capable' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', description: 'Previous gen, very fast' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', description: 'Most capable, slower' },
]

// TTS Providers and voices
const TTS_PROVIDERS = [
  { value: 'gemini', label: 'Gemini TTS (Recommended)', description: 'Uses same API key as AI' },
  { value: 'kokoro', label: 'Kokoro (Local)', description: 'Runs offline via the local Kokoro app - free, no API key, English + Hindi and 4 more languages' },
  { value: 'elevenlabs', label: 'ElevenLabs', description: 'High quality, natural voices' },
  { value: 'openai', label: 'OpenAI TTS', description: 'Good quality, fast' },
  { value: 'google', label: 'Google Cloud TTS', description: 'Many languages' },
  { value: 'edge', label: 'Edge TTS (Free)', description: 'Free, decent quality' },
]


// Kokoro voices - ids mirror KOKORO_TTS_VOICES in server/src/services/tts/types.ts
const KOKORO_VOICES = [
  { value: 'hf_alpha', label: 'Hindi Alpha', description: 'Hindi - Female' },
  { value: 'hf_beta', label: 'Hindi Beta', description: 'Hindi - Female' },
  { value: 'hm_omega', label: 'Hindi Omega', description: 'Hindi - Male' },
  { value: 'hm_psi', label: 'Hindi Psi', description: 'Hindi - Male' },
  { value: 'af_heart', label: 'Heart', description: 'English (US) - Female' },
  { value: 'af_bella', label: 'Bella', description: 'English (US) - Female' },
  { value: 'af_nicole', label: 'Nicole', description: 'English (US) - Female' },
  { value: 'af_sarah', label: 'Sarah', description: 'English (US) - Female' },
  { value: 'af_sky', label: 'Sky', description: 'English (US) - Female' },
  { value: 'am_michael', label: 'Michael', description: 'English (US) - Male' },
  { value: 'am_fenrir', label: 'Fenrir', description: 'English (US) - Male' },
  { value: 'am_echo', label: 'Echo', description: 'English (US) - Male' },
  { value: 'am_eric', label: 'Eric', description: 'English (US) - Male' },
  { value: 'bf_emma', label: 'Emma', description: 'English (UK) - Female' },
  { value: 'bf_isabella', label: 'Isabella', description: 'English (UK) - Female' },
  { value: 'bm_george', label: 'George', description: 'English (UK) - Male' },
  { value: 'bm_lewis', label: 'Lewis', description: 'English (UK) - Male' },
  { value: 'ef_dora', label: 'Spanish Dora', description: 'Spanish - Female' },
  { value: 'em_alex', label: 'Spanish Alex', description: 'Spanish - Male' },
  { value: 'ff_siwis', label: 'French Siwis', description: 'French - Female' },
  { value: 'if_sara', label: 'Italian Sara', description: 'Italian - Female' },
  { value: 'im_nicola', label: 'Italian Nicola', description: 'Italian - Male' },
  { value: 'pf_dora', label: 'Portuguese Dora', description: 'Portuguese - Female' },
  { value: 'pm_alex', label: 'Portuguese Alex', description: 'Portuguese - Male' },
]

const ELEVENLABS_VOICES = [
  { value: 'rachel', label: 'Rachel', description: 'American Female - Calm' },
  { value: 'drew', label: 'Drew', description: 'American Male - Well-rounded' },
  { value: 'clyde', label: 'Clyde', description: 'American Male - War Veteran' },
  { value: 'paul', label: 'Paul', description: 'American Male - Ground Reporter' },
  { value: 'domi', label: 'Domi', description: 'American Female - Strong' },
  { value: 'dave', label: 'Dave', description: 'British-Essex Male - Conversational' },
  { value: 'fin', label: 'Fin', description: 'Irish Male - Sailor' },
  { value: 'sarah', label: 'Sarah', description: 'American Female - Soft' },
  { value: 'antoni', label: 'Antoni', description: 'American Male - Well-rounded' },
  { value: 'thomas', label: 'Thomas', description: 'American Male - Calm' },
  { value: 'charlie', label: 'Charlie', description: 'Australian Male - Casual' },
  { value: 'george', label: 'George', description: 'British Male - Raspy' },
  { value: 'emily', label: 'Emily', description: 'American Female - Calm' },
  { value: 'elli', label: 'Elli', description: 'American Female - Emotional' },
  { value: 'callum', label: 'Callum', description: 'American Male - Hoarse' },
  { value: 'patrick', label: 'Patrick', description: 'American Male - Shouty' },
  { value: 'harry', label: 'Harry', description: 'American Male - Anxious' },
  { value: 'liam', label: 'Liam', description: 'American Male - Articulate' },
  { value: 'dorothy', label: 'Dorothy', description: 'British Female - Pleasant' },
  { value: 'josh', label: 'Josh', description: 'American Male - Deep' },
  { value: 'arnold', label: 'Arnold', description: 'American Male - Crisp' },
  { value: 'charlotte', label: 'Charlotte', description: 'English-Swedish Female - Seductive' },
  { value: 'matilda', label: 'Matilda', description: 'American Female - Warm' },
  { value: 'matthew', label: 'Matthew', description: 'British Male - Audiobook' },
  { value: 'james', label: 'James', description: 'Australian Male - Calm' },
  { value: 'joseph', label: 'Joseph', description: 'British Male - Narrator' },
  { value: 'jeremy', label: 'Jeremy', description: 'American-Irish Male - Excited' },
  { value: 'michael', label: 'Michael', description: 'American Male - Audiobook' },
  { value: 'ethan', label: 'Ethan', description: 'American Male - ASMR' },
  { value: 'gigi', label: 'Gigi', description: 'American Female - Childish' },
  { value: 'freya', label: 'Freya', description: 'American Female - Overhyped' },
  { value: 'grace', label: 'Grace', description: 'American-Southern Female' },
  { value: 'daniel', label: 'Daniel', description: 'British Male - Deep' },
  { value: 'serena', label: 'Serena', description: 'American Female - Pleasant' },
  { value: 'adam', label: 'Adam', description: 'American Male - Deep' },
  { value: 'nicole', label: 'Nicole', description: 'American Female - Whisper' },
  { value: 'jessie', label: 'Jessie', description: 'American Male - Raspy' },
  { value: 'ryan', label: 'Ryan', description: 'American Male - Soldier' },
  { value: 'sam', label: 'Sam', description: 'American Male - Raspy' },
  { value: 'glinda', label: 'Glinda', description: 'American Female - Witch' },
  { value: 'giovanni', label: 'Giovanni', description: 'English-Italian Male - Foreigner' },
  { value: 'mimi', label: 'Mimi', description: 'English-Swedish Female - Childish' },
]

// Gemini TTS voices (male only)
const GEMINI_VOICES = [
  { value: 'Charon', label: 'Charon', description: 'Deep, authoritative' },
  { value: 'Fenrir', label: 'Fenrir', description: 'Strong, powerful' },
  { value: 'Orus', label: 'Orus', description: 'Calm, narrator' },
  { value: 'Puck', label: 'Puck', description: 'Playful, energetic' },
  { value: 'Zephyr', label: 'Zephyr', description: 'Gentle, airy' },
  { value: 'Algenib', label: 'Algenib', description: 'Gravelly, rugged' },
  { value: 'Algieba', label: 'Algieba', description: 'Smooth, silky' },
  { value: 'Bellatrix', label: 'Bellatrix', description: 'Crisp, articulate' },
  { value: 'Gacrux', label: 'Gacrux', description: 'Mature, wise' },
  { value: 'Iapetus', label: 'Iapetus', description: 'Versatile narrator' },
  { value: 'Keid', label: 'Keid', description: 'Upbeat, cheerful' },
  { value: 'Kopernicus', label: 'Kopernicus', description: 'Measured, scholarly' },
  { value: 'Pegasus', label: 'Pegasus', description: 'Storytelling, narrative' },
  { value: 'Perseus', label: 'Perseus', description: 'Deep, commanding' },
  { value: 'Rasalhague', label: 'Rasalhague', description: 'Even, balanced' },
  { value: 'Sadaltager', label: 'Sadaltager', description: 'Knowledgeable' },
  { value: 'Sulafat', label: 'Sulafat', description: 'Warm, friendly' },
  { value: 'Zubenelgenubi', label: 'Zubenelgenubi', description: 'Casual, conversational' },
]

export default function Settings() {
  const { toast } = useToast()
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [settings, setSettings] = useState<ExtendedSettings | null>(null)
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [savingApiKey, setSavingApiKey] = useState(false)
  const [kokoroStatus, setKokoroStatus] = useState<{ available: boolean; error?: string; url?: string } | null>(null)
  
  useEffect(() => {
    loadSettings()
  }, [])

  // Probe the local Kokoro app so the user sees whether it is running
  useEffect(() => {
    if (settings?.ttsProvider !== 'kokoro') {
      setKokoroStatus(null)
      return
    }

    let cancelled = false

    voiceoverApi.getKokoroStatus()
      .then(status => { if (!cancelled) setKokoroStatus(status) })
      .catch(() => { if (!cancelled) setKokoroStatus({ available: false }) })

    return () => { cancelled = true }
  }, [settings?.ttsProvider])
  
  const loadSettings = async () => {
    try {
      const [data, ai] = await Promise.all([
        settingsApi.getAll(),
        narrationApi.getAIStatus().catch(() => null)
      ])
      setSettings(data as ExtendedSettings)
      setAIStatus(ai)
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
  
  const handleSave = async () => {
    if (!settings) return
    
    setSaving(true)
    
    try {
      await settingsApi.updateAll(settings)
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
      setSettings(defaults as ExtendedSettings)
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
  
  const updateSetting = (key: keyof ExtendedSettings, value: string) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
  }
  
  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter an API key',
        variant: 'destructive'
      })
      return
    }
    
    setSavingApiKey(true)
    try {
      const result = await narrationApi.saveApiKey(apiKey.trim())
      
      if (result.connectionTest?.success) {
        toast({
          title: 'API Key Saved',
          description: 'Gemini API is now configured and connected!'
        })
        setApiKey('')
        // Refresh AI status
        const newStatus = await narrationApi.getAIStatus()
        setAIStatus(newStatus)
      } else {
        toast({
          title: 'API Key Saved',
          description: result.connectionTest?.error || 'Key saved but connection test failed. Please verify the key.',
          variant: 'destructive'
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save API key',
        variant: 'destructive'
      })
    } finally {
      setSavingApiKey(false)
    }
  }
  
  const handleAIModelChange = async (key: 'aiScriptModel' | 'aiSummaryModel', value: string) => {
    updateSetting(key, value)
    
    // Auto-save model settings
    try {
      const scriptModel = key === 'aiScriptModel' ? value : (settings?.aiScriptModel || 'gemini-2.0-flash')
      const summaryModel = key === 'aiSummaryModel' ? value : (settings?.aiSummaryModel || 'gemini-2.0-flash')
      
      await narrationApi.saveAIModels(scriptModel, summaryModel)
      toast({
        title: 'Model Updated',
        description: `Now using ${value}`,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save model setting',
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
              Configure download, scraping, and AI behavior
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
      <div className="flex-1 overflow-auto">
        <Tabs defaultValue="appearance" className="w-full h-full">
          <TabsList className="sticky top-0 w-full justify-start rounded-none border-b bg-background px-6">
            <TabsTrigger value="appearance" className="flex items-center gap-2">
              <Palette className="h-4 w-4" />
              <span>Appearance</span>
            </TabsTrigger>
            <TabsTrigger value="download" className="flex items-center gap-2">
              <Download className="h-4 w-4" />
              <span>Download & Performance</span>
            </TabsTrigger>
            <TabsTrigger value="narration" className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <span>Narration Studio</span>
            </TabsTrigger>
            <TabsTrigger value="voiceover" className="flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
              <span>Voiceover</span>
            </TabsTrigger>
            <TabsTrigger value="clipper" className="flex items-center gap-2">
              <Crop className="h-4 w-4" />
              <span>Image Clipper</span>
            </TabsTrigger>
            <TabsTrigger value="crop-pointers" className="flex items-center gap-2">
              <Locate className="h-4 w-4" />
              <span>Crop Pointers</span>
            </TabsTrigger>
            <TabsTrigger value="crop3-prompts" className="flex items-center gap-2">
              <Crop className="h-4 w-4" />
              <span>Crop 3.0 - Prompts</span>
            </TabsTrigger>
            <TabsTrigger value="editor2" className="flex items-center gap-2">
              <Film className="h-4 w-4" />
              <span>Editor 2.0</span>
            </TabsTrigger>
          </TabsList>

          {/* Appearance Tab */}
          <TabsContent value="appearance" className="p-6 max-w-4xl space-y-6">
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
          <TabsContent value="download" className="p-6 max-w-4xl space-y-6">
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

          {/* Narration Studio Tab */}
          <TabsContent value="narration" className="p-6 max-w-4xl space-y-6">
      {/* AI Provider Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            AI Provider
          </CardTitle>
          <CardDescription>
            Configure Gemini AI for script generation
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status Display */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted">
            <div className="flex items-center gap-3">
              {aiStatus?.configured ? (
                <CheckCircle className="h-5 w-5 text-green-500" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive" />
              )}
              <div>
                <p className="font-medium">
                  {aiStatus?.configured ? 'AI Configured' : 'AI Not Configured'}
                </p>
                {aiStatus?.configured && (
                  <p className="text-sm text-muted-foreground">
                    Provider: {aiStatus.defaultProvider} • Model: {aiStatus.model}
                  </p>
                )}
              </div>
            </div>
            {aiStatus?.configured && (
              <Badge variant={aiStatus.connectionTest?.success ? 'default' : 'destructive'}>
                {aiStatus.connectionTest?.success ? 'Connected' : 'Error'}
              </Badge>
            )}
          </div>
          
          {/* API Key Input */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="apiKey" className="font-medium">Gemini API Key</Label>
            </div>
            <div className="flex gap-2">
              <Input
                id="apiKey"
                type="password"
                placeholder={aiStatus?.hasApiKey ? '••••••••••••••••' : 'Paste your Gemini API key'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono"
              />
              <Button 
                onClick={handleSaveApiKey}
                disabled={!apiKey.trim() || savingApiKey}
              >
                {savingApiKey ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {aiStatus?.hasApiKey 
                ? 'API key is saved. Enter a new key to replace it.'
                : 'Get your free API key from Google AI Studio'}
            </p>
          </div>
          
          {/* Help Link */}
          <div className="pt-2 border-t">
            <a 
              href="https://aistudio.google.com/apikey" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-4 w-4" />
              Get a free Gemini API key from Google AI Studio
            </a>
          </div>
        </CardContent>
      </Card>
      
      {/* AI Model Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" />
            AI Model Selection
          </CardTitle>
          <CardDescription>
            Choose which AI models to use for different tasks
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Script Generation Model */}
          <div className="space-y-2">
            <Label>Script Generation Model</Label>
            <Select
              value={settings.aiScriptModel || 'gemini-2.0-flash'}
              onValueChange={(value) => handleAIModelChange('aiScriptModel', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {GEMINI_MODELS.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    <div className="flex flex-col">
                      <span>{model.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Used for analyzing images and generating narration scripts
            </p>
          </div>

          {/* Summary Generation Model */}
          <div className="space-y-2">
            <Label>Summary Generation Model</Label>
            <Select
              value={settings.aiSummaryModel || 'gemini-2.0-flash'}
              onValueChange={(value) => handleAIModelChange('aiSummaryModel', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {GEMINI_MODELS.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    <div className="flex flex-col">
                      <span>{model.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Used for generating chapter summaries and continuity data
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Base Style Prompt */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" />
            Narration Style (Script Content)
          </CardTitle>
          <CardDescription>
            Controls how the AI writes the script text. This affects the content and writing style.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="basePrompt">Base Style Prompt</Label>
            <Textarea
              id="basePrompt"
              rows={8}
              value={settings.narrationBasePrompt || `You are writing a manhwa recap narration script for audiobook-style delivery.

STYLE RULES:
- Third-person narration with clear, straightforward prose
- Calm, measured tone - avoid dramatic exclamations or over-the-top language
- No prologue or epilogue - start directly with the story action
- No ending/epilogue lines (unless this is explicitly marked as a Part end)
- Keep dialogue natural but not exaggerated
- Use present tense for action, past tense for backstory
- Keep paragraphs short for easy voice-over reading
- Do NOT include stage directions like [excited], [whisper], *sighs*, etc.
- Avoid excessive punctuation (!!!, ???, ...) - use periods and commas
- Write for a neutral reading pace - no dramatic pauses needed`}
              onChange={(e) => updateSetting('narrationBasePrompt', e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              This prompt is prepended to every script generation request. Customize the tone and style here.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Image Processing Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            AI Image Processing
          </CardTitle>
          <CardDescription>
            Control how chapter images are processed for AI
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="aiMaxWidth">Max Image Width (px)</Label>
            <Input
              id="aiMaxWidth"
              type="number"
              min="480"
              max="2048"
              value={settings.narrationImageMaxWidth || '1080'}
              onChange={(e) => updateSetting('narrationImageMaxWidth', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Images are downscaled to this width before sending to AI (saves tokens/cost).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="singleCallCap">Single-Call Image Limit</Label>
            <Input
              id="singleCallCap"
              type="number"
              min="5"
              max="50"
              value={settings.narrationSingleCallCap || '30'}
              onChange={(e) => updateSetting('narrationSingleCallCap', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Chapters with more images than this will use map-reduce batching.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="batchSize">Batch Size (for large chapters)</Label>
            <Input
              id="batchSize"
              type="number"
              min="5"
              max="30"
              value={settings.narrationBatchSize || '20'}
              onChange={(e) => updateSetting('narrationBatchSize', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Number of images per batch when using map-reduce.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="summaryLength">Target Summary Length (words)</Label>
            <Input
              id="summaryLength"
              type="number"
              min="50"
              max="500"
              value={settings.narrationSummaryLength || '200'}
              onChange={(e) => updateSetting('narrationSummaryLength', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Approximate word count for rolling chapter summaries.
            </p>
          </div>
        </CardContent>
      </Card>

      <ScriptWithTimestampPromptCard />
          </TabsContent>

          {/* Voiceover Tab */}
          <TabsContent value="voiceover" className="p-6 max-w-4xl space-y-6">
      {/* TTS Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Volume2 className="h-5 w-5" />
            Text-to-Speech (TTS)
          </CardTitle>
          <CardDescription>
            Configure voice synthesis for audio narration (Module 3)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* TTS Provider */}
          <div className="space-y-2">
            <Label>TTS Provider</Label>
            <Select
              value={settings.ttsProvider || 'elevenlabs'}
              onValueChange={(value) => updateSetting('ttsProvider', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {TTS_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.value} value={provider.value}>
                    <div className="flex flex-col">
                      <span>{provider.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {TTS_PROVIDERS.find(p => p.value === (settings.ttsProvider || 'elevenlabs'))?.description}
            </p>
          </div>
          
          {/* ElevenLabs API Key */}
          {(settings.ttsProvider === 'elevenlabs' || !settings.ttsProvider) && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                <Label>ElevenLabs API Key</Label>
              </div>
              <Input
                type="password"
                placeholder="Enter ElevenLabs API key"
                value={settings.ttsApiKey || ''}
                onChange={(e) => updateSetting('ttsApiKey' as keyof ExtendedSettings, e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Get your API key from{' '}
                <a 
                  href="https://elevenlabs.io" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  ElevenLabs
                </a>
              </p>
            </div>
          )}
          
          {/* Voice Selection */}
          {(settings.ttsProvider === 'elevenlabs' || !settings.ttsProvider) && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mic className="h-4 w-4 text-muted-foreground" />
                <Label>Voice</Label>
              </div>
              <Select
                value={settings.ttsVoice || 'rachel'}
                onValueChange={(value) => updateSetting('ttsVoice', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select voice" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {ELEVENLABS_VOICES.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value}>
                      <span>{voice.label} - <span className="text-muted-foreground">{voice.description}</span></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          
          {/* Gemini Voice Selection */}
          {settings.ttsProvider === 'gemini' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mic className="h-4 w-4 text-muted-foreground" />
                <Label>Voice</Label>
              </div>
              <Select
                value={settings.ttsVoice || 'Iapetus'}
                onValueChange={(value) => updateSetting('ttsVoice', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select voice" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {GEMINI_VOICES.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value}>
                      <span>{voice.label} - <span className="text-muted-foreground">{voice.description}</span></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Gemini TTS uses the same API key as AI - no separate key needed.
                <br />
                <span className="text-amber-600 dark:text-amber-400">Tip: More expressive voices exaggerate emotion — audition several and pick the most even-sounding one for narration.</span>
              </p>
            </div>
          )}
          
          {/* Kokoro Voice Selection */}
          {settings.ttsProvider === 'kokoro' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mic className="h-4 w-4 text-muted-foreground" />
                <Label>Voice</Label>
                {kokoroStatus && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      kokoroStatus.available
                        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                        : 'bg-red-500/10 text-red-600 dark:text-red-400'
                    }`}
                  >
                    {kokoroStatus.available ? 'Server online' : 'Server offline'}
                  </span>
                )}
              </div>
              <Select
                value={settings.ttsKokoroVoice || 'hf_alpha'}
                onValueChange={(value) => updateSetting('ttsKokoroVoice' as keyof ExtendedSettings, value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select voice" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {KOKORO_VOICES.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value}>
                      <span>{voice.label} - <span className="text-muted-foreground">{voice.description}</span></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {kokoroStatus && !kokoroStatus.available ? (
                <p className="text-xs text-red-600 dark:text-red-400">
                  Cannot reach the Kokoro app at {kokoroStatus.url || 'http://127.0.0.1:7860'}. Start it before generating audio.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Runs locally - no API key and no rate limits. 24 voices: 13 English (US/UK), 4 Hindi, plus Spanish, French, Italian and Portuguese.
                  <br />
                  <span className="text-amber-600 dark:text-amber-400">Note: Kokoro ignores the delivery instruction below - it is a pure TTS model. Use Speech Speed to adjust pacing.</span>
                </p>
              )}
            </div>
          )}

          {/* Speech Speed */}
          <div className="space-y-2">
            <Label>Speech Speed</Label>
            <Select
              value={settings.ttsSpeed || '1.0'}
              onValueChange={(value) => updateSetting('ttsSpeed', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select speed" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0.75">0.75x (Slower)</SelectItem>
                <SelectItem value="0.9">0.9x</SelectItem>
                <SelectItem value="1.0">1.0x (Normal)</SelectItem>
                <SelectItem value="1.1">1.1x</SelectItem>
                <SelectItem value="1.25">1.25x (Faster)</SelectItem>
                <SelectItem value="1.5">1.5x</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <Separator />
          
          {/* TTS Style Instruction - not supported by pure TTS models like Kokoro */}
          <div className={`space-y-2 ${settings.ttsProvider === 'kokoro' ? 'opacity-50' : ''}`}>
            <Label htmlFor="ttsStylePrompt">
              TTS Voice Delivery Instruction
              {settings.ttsProvider === 'kokoro' && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">(not used by Kokoro)</span>
              )}
            </Label>
            <Textarea
              id="ttsStylePrompt"
              rows={5}
              value={settings.ttsStylePrompt || `Narrate in a calm, steady, neutral voice, like an audiobook narrator. Keep an even tone and a measured, consistent pace. Use minimal emotional inflection and smooth, natural phrasing. Do not dramatize, perform, or over-emphasize, and do not raise pitch for excitement. Read straight through.`}
              onChange={(e) => updateSetting('ttsStylePrompt', e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Controls how the TTS voice reads the text aloud (tone, pace, emotion). This does NOT affect script content.
            </p>
          </div>
          
          {/* Text Normalization Toggle */}
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <div className="space-y-0.5">
              <Label>Normalize Text for TTS</Label>
              <p className="text-xs text-muted-foreground">
                Automatically calm punctuation, remove stage directions, and reduce dramatic emphasis before TTS generation.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {settings.ttsNormalizeText === 'false' ? 'Off' : 'On'}
              </span>
              <Button
                variant={settings.ttsNormalizeText === 'false' ? 'outline' : 'default'}
                size="sm"
                onClick={() => updateSetting('ttsNormalizeText', settings.ttsNormalizeText === 'false' ? 'true' : 'false')}
              >
                {settings.ttsNormalizeText === 'false' ? 'Enable' : 'Disable'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/50">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> TTS API keys should be stored in your .env file for security, not in the database.
          </p>
        </CardContent>
      </Card>
          </TabsContent>

          {/* Image Clipper Tab — Module 3 v1 (AI Crop Lab) */}
          <TabsContent value="clipper" className="p-6 max-w-4xl space-y-6">
      {/* Crop guidelines — the immutable spec the default model follows */}
      <CropGuidelinesCard />

      <Card className="bg-muted/50">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> These guidelines control how the AI analyzes and suggests crops. Edit them to fine-tune crop detection behavior.
          </p>
        </CardContent>
      </Card>
          </TabsContent>

          {/* Crop Pointers Tab — Image Clipper 2.0's guidelines, which are also the
              prompt the manual loop copies into an external AI. Split out of the
              Image Clipper tab because this document is edited far more often: it is
              what the user actually iterates on when tuning crop quality. */}
          <TabsContent value="crop-pointers" className="p-6 max-w-4xl space-y-6">
      <CropPointGuidelinesCard />

      <Card className="bg-muted/50">
        <CardContent className="py-4 space-y-2">
          <p className="text-sm text-muted-foreground">
            <strong>This document is the prompt.</strong> Both ways of getting pointers send it
            verbatim: the in-app Gemini detector, and the manual loop where you copy it into
            ChatGPT or Claude and bring the JSON back.
          </p>
          <p className="text-sm text-muted-foreground">
            Copy it from <strong>Narration Studio → Manual → Step 3</strong> (the chat there already
            holds the chapter's pages), or from the <strong>Image Clipper 2.0</strong> workspace.
            Editing it here changes what both paths send on the very next run.
          </p>
        </CardContent>
      </Card>
          </TabsContent>

          {/* Crop 3.0 - Prompts Tab */}
          <TabsContent value="crop3-prompts" className="p-6 max-w-4xl space-y-6">
      <VisionProviderCard />
      <Crop3GuidelineFileCard />
      <Crop3MetadataTemplateCard />
      <Crop3PromptCard />
          </TabsContent>

          {/* Editor 2.0 Tab — Module 4v2 (video compile/timeline/render workspace) */}
          <TabsContent value="editor2" className="p-6 max-w-4xl space-y-6">
      <Editor2PromptCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

/**
 * Crop Guidelines editor — the canonical rules the default "Guidelines (Gemini)"
 * crop model follows. The file is read-only on disk; this is the single
 * intentional, user-driven path to change it.
 */
function CropGuidelinesCard() {
  const { toast } = useToast()
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    aiCropApi.getGuidelines()
      .then(g => { setContent(g.content); setUpdatedAt(g.updatedAt) })
      .catch(() => toast({ title: 'Could not load guidelines', variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [])

  const startEdit = () => { setDraft(content); setEditing(true) }
  const cancelEdit = () => setEditing(false)

  const save = async () => {
    if (!draft.trim()) {
      toast({ title: 'Guidelines cannot be empty', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await aiCropApi.updateGuidelines(draft)
      setContent(draft)
      setUpdatedAt(res.updatedAt)
      setEditing(false)
      toast({ title: 'Guidelines updated', description: 'The default model will follow the new guidelines.' })
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Crop Guidelines
        </CardTitle>
        <CardDescription>
          The written rules the default <strong>Guidelines (Gemini)</strong> crop model follows.
          Stored read-only on disk — only this editor can change them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : editing ? (
          <>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs min-h-[420px]"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Guidelines
              </Button>
              <Button variant="outline" onClick={cancelEdit} disabled={saving}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Read-only</Badge>
              {updatedAt && <span>Last edited {new Date(updatedAt).toLocaleString()}</span>}
            </div>
            <Textarea
              value={content}
              readOnly
              className="font-mono text-xs min-h-[260px] bg-muted/40"
              spellCheck={false}
            />
            <Button variant="outline" onClick={startEdit}>
              <Wand2 className="h-4 w-4 mr-2" />
              Edit guidelines
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Crop Detection Guidelines editor for Image Clipper 2.0.
 *
 * The document is handed to a vision model verbatim by BOTH paths that produce
 * pointers — the in-app Gemini detector and the manual copy-into-ChatGPT loop — so
 * editing it changes how the module crops on the very next run, either way.
 *
 * The file is stored read-only (0444) on disk and this card is its only write path;
 * a reset copies the shipped default back.
 */
function CropPointGuidelinesCard() {
  const { toast } = useToast()
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [isDefault, setIsDefault] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    clipper2Api.getGuidelines()
      .then(g => { setContent(g.content); setUpdatedAt(g.updatedAt); setIsDefault(g.isDefault) })
      .catch(() => toast({ title: 'Could not load crop point guidelines', variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [])

  const startEdit = () => { setDraft(content); setEditing(true) }
  const cancelEdit = () => setEditing(false)

  const save = async () => {
    if (!draft.trim()) {
      toast({ title: 'Crop point guidelines cannot be empty', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      // The response carries the bytes now on disk, so state never drifts from the file.
      const res = await clipper2Api.updateGuidelines(draft)
      setContent(res.content)
      setUpdatedAt(res.updatedAt)
      setIsDefault(res.isDefault)
      setEditing(false)
      toast({
        title: 'Crop point guidelines updated',
        description: 'The pointer detector will follow the new document on the next detection run.'
      })
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const restoreDefault = async () => {
    // A confirm rather than an undo: the reset overwrites the active document and
    // the user's own version is not kept anywhere.
    if (!window.confirm('Restore the shipped crop point guidelines? This discards any local edits to the document.')) {
      return
    }
    setRestoring(true)
    try {
      const res = await clipper2Api.resetGuidelines()
      setContent(res.content)
      setUpdatedAt(res.updatedAt)
      setIsDefault(res.isDefault)
      setEditing(false)
      toast({
        title: 'Default crop point guidelines restored',
        description: 'The pointer detector will follow the shipped document on the next detection run.'
      })
    } catch (err) {
      toast({ title: 'Restore failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Crop Detection Guidelines
        </CardTitle>
        <CardDescription>
          The written rules that govern how Image Clipper 2.0 places its <strong>four crop pointers</strong>{' '}
          (P1 top-left, P2 top-right, P3 bottom-right, P4 bottom-left) around every meaningful section of a
          chapter. Stored read-only on disk, so no automated detect or apply run can change the document it
          is judged against — this editor is the only path that writes it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : editing ? (
          <>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs min-h-[420px]"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Guidelines
              </Button>
              <Button variant="outline" onClick={cancelEdit} disabled={saving}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Read-only</Badge>
              {isDefault && <Badge variant="secondary">Default</Badge>}
              {updatedAt && <span>Last edited {new Date(updatedAt).toLocaleString()}</span>}
            </div>
            <Textarea
              value={content}
              readOnly
              className="font-mono text-xs min-h-[260px] bg-muted/40"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={startEdit}>
                <Wand2 className="h-4 w-4 mr-2" />
                Edit guidelines
              </Button>
              <Button variant="outline" onClick={restoreDefault} disabled={restoring}>
                {restoring ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                Restore default
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// localStorage keys for Crop 3.0 — kept local to the browser, not synced to the server.
const CROP3_GUIDELINE_FILE_KEY = 'crop3.guidelineFile'
const CROP3_METADATA_TEMPLATE_KEY = 'crop3.metadataTemplate'
const CROP3_PROMPT_KEY = 'crop3.prompt'

interface Crop3StoredFile {
  name: string
  content: string
  savedAt: string
}

/**
 * Generic Crop 3.0 file uploader card. The file is read as text and auto-saved
 * to the browser's localStorage as soon as it's selected — there is no
 * separate save step. "Replace" just re-opens the file picker and overwrites it.
 */
function Crop3FileUploadCard({
  storageKey,
  title,
  description,
  uploadLabel,
  savedLabel
}: {
  storageKey: string
  title: string
  description: string
  uploadLabel: string
  savedLabel: string
}) {
  const { toast } = useToast()
  const [file, setFile] = useState<Crop3StoredFile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setFile(JSON.parse(raw))
    } catch {
      // ignore corrupt/missing local state
    } finally {
      setLoading(false)
    }
  }, [storageKey])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    e.target.value = ''
    if (!selected) return

    const reader = new FileReader()
    reader.onload = () => {
      const entry: Crop3StoredFile = {
        name: selected.name,
        content: String(reader.result ?? ''),
        savedAt: new Date().toISOString()
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(entry))
        setFile(entry)
        toast({ title: `${savedLabel} saved`, description: `${selected.name} saved locally in this browser.` })
      } catch (err) {
        toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Could not save to local storage', variant: 'destructive' })
      }
    }
    reader.onerror = () => {
      toast({ title: 'Read failed', description: 'Could not read the selected file', variant: 'destructive' })
    }
    reader.readAsText(selected)
  }

  const removeFile = () => {
    if (!window.confirm(`Remove the saved ${savedLabel.toLowerCase()}?`)) return
    localStorage.removeItem(storageKey)
    setFile(null)
  }

  const downloadFile = () => {
    if (!file) return
    const blob = new Blob([file.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : file ? (
          <>
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted">
              <div>
                <p className="font-medium text-sm">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  Saved {new Date(file.savedAt).toLocaleString()}
                </p>
              </div>
              <Badge variant="outline">Saved locally</Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" asChild>
                <label className="cursor-pointer">
                  <Upload className="h-4 w-4 mr-2" />
                  Replace
                  <input type="file" className="hidden" onChange={handleFileChange} />
                </label>
              </Button>
              <Button variant="outline" onClick={downloadFile}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
              <Button variant="outline" onClick={removeFile}>Remove</Button>
            </div>
          </>
        ) : (
          <Button variant="outline" asChild>
            <label className="cursor-pointer">
              <Upload className="h-4 w-4 mr-2" />
              {uploadLabel}
              <input type="file" className="hidden" onChange={handleFileChange} />
            </label>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function Crop3GuidelineFileCard() {
  return (
    <Crop3FileUploadCard
      storageKey={CROP3_GUIDELINE_FILE_KEY}
      title="Guideline File"
      description="Upload a guideline file for Crop 3.0. It's saved automatically in this browser's local storage — no separate save step."
      uploadLabel="Upload guideline file"
      savedLabel="Guideline file"
    />
  )
}

function Crop3MetadataTemplateCard() {
  return (
    <Crop3FileUploadCard
      storageKey={CROP3_METADATA_TEMPLATE_KEY}
      title="Metadata Template"
      description="Upload a metadata template document for Crop 3.0. It's saved automatically in this browser's local storage — no separate save step."
      uploadLabel="Upload metadata template"
      savedLabel="Metadata template"
    />
  )
}

/**
 * Crop 3.0 prompt editor. Single free-text prompt, auto-loaded from and saved
 * to the browser's localStorage. Edit/Save mirrors the guideline-doc cards
 * elsewhere in Settings, but nothing here reaches the server.
 */
function Crop3PromptCard() {
  const { toast } = useToast()
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CROP3_PROMPT_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { content: string; savedAt: string }
        setContent(parsed.content)
        setSavedAt(parsed.savedAt)
      }
    } catch {
      // ignore corrupt/missing local state
    }
  }, [])

  const startEdit = () => { setDraft(content); setEditing(true) }
  const cancelEdit = () => setEditing(false)

  const save = () => {
    const savedAtIso = new Date().toISOString()
    try {
      localStorage.setItem(CROP3_PROMPT_KEY, JSON.stringify({ content: draft, savedAt: savedAtIso }))
      setContent(draft)
      setSavedAt(savedAtIso)
      setEditing(false)
      toast({ title: 'Prompt saved', description: 'Saved locally in this browser.' })
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Could not save to local storage', variant: 'destructive' })
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
          The prompt used for Crop 3.0. Saved locally in this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              className="font-mono text-sm"
              placeholder="Enter the Crop 3.0 prompt..."
            />
            <div className="flex gap-2">
              <Button onClick={save}>
                <Save className="h-4 w-4 mr-2" />
                Save
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
              rows={10}
              className="font-mono text-sm bg-muted/40"
              placeholder="No prompt saved yet."
            />
            <Button variant="outline" onClick={startEdit}>
              <Wand2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// localStorage key for the Editor 2.0 prompt — kept local to the browser,
// same as the Crop 3.0 documents, not synced to the server.
const EDITOR2_PROMPT_KEY = 'editor2.prompt'

/**
 * Editor 2.0 prompt editor. View/Edit/Save, like the crop guideline cards —
 * the field is read-only until "Edit" is pressed, so pasting a replacement
 * can't clobber the saved prompt by accident.
 *
 * Saved to the browser's localStorage (mirrors Crop3PromptCard) so it
 * survives a page refresh without needing a server round-trip.
 */
function Editor2PromptCard() {
  const { toast } = useToast()
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

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
  }, [])

  const startEdit = () => { setDraft(content); setEditing(true) }
  const cancelEdit = () => setEditing(false)

  const save = () => {
    const savedAtIso = new Date().toISOString()
    try {
      localStorage.setItem(EDITOR2_PROMPT_KEY, JSON.stringify({ content: draft, savedAt: savedAtIso }))
      setContent(draft)
      setSavedAt(savedAtIso)
      setEditing(false)
      toast({ title: 'Prompt saved', description: 'Saved locally in this browser.' })
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Could not save to local storage', variant: 'destructive' })
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
          The prompt used by Editor 2.0. Saved locally in this browser.
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
              <Button onClick={save}>
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
            <Button variant="outline" onClick={startEdit}>
              <Wand2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * "Script with Timestamp - Prompt" editor, part of the Narration Studio tab.
 *
 * Persisted server-side through the generic settings key/value store, so the
 * prompt follows the project rather than the browser it was typed in.
 */
function ScriptWithTimestampPromptCard() {
  const { toast } = useToast()
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    settingsApi.getAll()
      .then(all => setValue(((all as ExtendedSettings).scriptWithTimestampPrompt) ?? ''))
      .catch(() => toast({ title: 'Could not load prompt', variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await settingsApi.update('scriptWithTimestampPrompt', value)
      toast({ title: 'Prompt saved', description: 'Script with Timestamp - Prompt updated.' })
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Script with Timestamp - Prompt
        </CardTitle>
        <CardDescription>
          The prompt used when generating a script annotated with timestamps.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <Label htmlFor="scriptWithTimestampPrompt">Prompt</Label>
            <Textarea
              id="scriptWithTimestampPrompt"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste the Script with Timestamp prompt here…"
              className="font-mono text-xs min-h-[320px]"
              spellCheck={false}
            />
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save Prompt
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Which AI model answers "where are the crops in this image".
 *
 * Qwen3-VL runs locally through Ollama — no API key and nothing leaves the
 * machine, but it has to actually be running, which is why Test is a separate
 * button rather than something inferred from the listing. The cloud providers
 * are configured by environment variable (GEMINI_API_KEY, OPENAI_API_KEY,
 * ANTHROPIC_API_KEY); one without a key is listed but not selectable, so the
 * reason it is unavailable is visible rather than silent.
 */
function VisionProviderCard() {
  const { toast } = useToast()
  const [providers, setProviders] = useState<VisionProviderInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { success: boolean; error?: string }>>({})

  useEffect(() => {
    visionApi.getProviders()
      .then(res => {
        setProviders(res.providers)
        setSelected(res.selected)
      })
      .catch(() => toast({ title: 'Could not load AI providers', variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [])

  const select = async (provider: VisionProviderName) => {
    const previous = selected
    setSelected(provider)
    try {
      await visionApi.selectProvider(provider)
      toast({ title: 'AI model updated' })
    } catch (error) {
      setSelected(previous)
      toast({
        title: 'Could not save',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      })
    }
  }

  const test = async (provider: VisionProviderName) => {
    setTesting(provider)
    try {
      const result = await visionApi.testProvider(provider)
      setResults(prev => ({ ...prev, [provider]: result }))
      toast({
        title: result.success ? 'Connection OK' : 'Not reachable',
        description: result.success ? result.model : result.error,
        variant: result.success ? undefined : 'destructive'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      setResults(prev => ({ ...prev, [provider]: { success: false, error: message } }))
      toast({ title: 'Test failed', description: message, variant: 'destructive' })
    } finally {
      setTesting(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Crop Detection Model
        </CardTitle>
        <CardDescription>
          Which AI reads a page and returns its crop pointers, for the one-click
          Detect in Image Clipper 3.0. It is sent the prompts below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading providers…
          </div>
        ) : (
          providers.map(provider => {
            const isSelected = selected === provider.name
            const result = results[provider.name]
            return (
              <div
                key={provider.name}
                className={`flex items-center gap-3 rounded-lg border p-3 ${
                  isSelected ? 'border-primary bg-primary/5' : ''
                }`}
              >
                {provider.isLocal ? (
                  <Cpu className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                ) : (
                  <Cloud className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{provider.label}</span>
                    {provider.isLocal && (
                      <Badge variant="secondary" className="text-xs">Offline</Badge>
                    )}
                    {!provider.configured && (
                      <Badge variant="outline" className="text-xs">No API key</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {provider.model ?? 'not configured'}
                    {result && (
                      <span className={result.success ? ' text-green-500' : ' text-destructive'}>
                        {result.success ? ' · reachable' : ` · ${result.error}`}
                      </span>
                    )}
                  </p>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => test(provider.name)}
                  disabled={testing === provider.name || !provider.configured}
                >
                  {testing === provider.name ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : result?.success ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : result ? (
                    <XCircle className="h-4 w-4 text-destructive" />
                  ) : (
                    'Test'
                  )}
                </Button>

                <Button
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => select(provider.name)}
                  disabled={isSelected || !provider.configured}
                >
                  {isSelected ? 'Selected' : 'Use'}
                </Button>
              </div>
            )
          })
        )}

        <p className="text-xs text-muted-foreground pt-1">
          Qwen3-VL runs on this machine through Ollama — install it, then run{' '}
          <code className="px-1 py-0.5 rounded bg-muted">ollama pull qwen3-vl:4b</code>.
          Nothing is uploaded. Cloud models need their API key set in the server environment.
        </p>
      </CardContent>
    </Card>
  )
}
