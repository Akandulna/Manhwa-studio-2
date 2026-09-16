/**
 * Murgaa Dialog
 *
 * The reference popup behind the "Murgaa" header button on the narration
 * Script Editor and Voiceover Editor pages, and the Image Clipper 3.0
 * image-list page.
 *
 * Three sections: an image preview (expandable to fullscreen), a short
 * description, and a LIST of launchable applications — each independently
 * uploaded, renamed, launched and removed. Edit mode swaps in controls to
 * change the description, (re)upload the image, and manage that list.
 *
 * Config is global per `scope` — every manhwa shows the same popup on a given
 * page, and the two pages are configured independently.
 */

import { useCallback, useEffect, useState } from 'react'
import { murgaaApi, MurgaaApp, MurgaaConfig, MurgaaScope } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import {
  Image as ImageIcon,
  Maximize2,
  X,
  Pencil,
  Upload,
  ExternalLink,
  Loader2,
  Save,
  AlertTriangle,
  Plus,
  Trash2,
  Check,
} from 'lucide-react'

interface MurgaaDialogProps {
  scope: MurgaaScope
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MurgaaDialog({ scope, open, onOpenChange }: MurgaaDialogProps) {
  const { toast } = useToast()

  const [config, setConfig] = useState<MurgaaConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftDescription, setDraftDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [addingApp, setAddingApp] = useState(false)
  const [launchingAppId, setLaunchingAppId] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  // Rename is inline, one app at a time: which app's name is being edited,
  // and the in-progress text for it.
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null)
  const [draftAppName, setDraftAppName] = useState('')
  const [renamingSaving, setRenamingSaving] = useState(false)
  const [removingAppId, setRemovingAppId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await murgaaApi.get(scope)
      setConfig(data)
      setDraftDescription(data.description)
    } catch (error) {
      toast({
        title: 'Failed to load Murgaa',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [scope, toast])

  // Refetch on each open so edits made from the other page show up here.
  useEffect(() => {
    if (open) {
      load()
      setEditing(false)
      setFullscreen(false)
      setRenamingAppId(null)
    }
  }, [open, load])

  const handleSaveDescription = async () => {
    setSaving(true)
    try {
      const updated = await murgaaApi.updateDescription(scope, draftDescription)
      setConfig(updated)
      setEditing(false)
      toast({ title: 'Murgaa updated' })
    } catch (error) {
      toast({
        title: 'Failed to save',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleImageUpload = async (file: File) => {
    setUploadingImage(true)
    try {
      const updated = await murgaaApi.uploadImage(scope, file)
      setConfig(updated)
      toast({ title: 'Image updated' })
    } catch (error) {
      toast({
        title: 'Image upload failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setUploadingImage(false)
    }
  }

  const handleAddApp = async (file: File) => {
    setAddingApp(true)
    try {
      const updated = await murgaaApi.addApp(scope, file)
      setConfig(updated)
      toast({ title: 'Application added' })
    } catch (error) {
      toast({
        title: 'Application upload failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setAddingApp(false)
    }
  }

  const handleLaunch = async (app: MurgaaApp) => {
    setLaunchingAppId(app.id)
    try {
      await murgaaApi.launchApp(scope, app.id)
      toast({ title: `Opening ${app.name}…` })
    } catch (error) {
      toast({
        title: 'Could not open application',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setLaunchingAppId(null)
    }
  }

  const startRenaming = (app: MurgaaApp) => {
    setRenamingAppId(app.id)
    setDraftAppName(app.name)
  }

  const handleRenameApp = async () => {
    if (!renamingAppId || !draftAppName.trim()) return
    setRenamingSaving(true)
    try {
      const updated = await murgaaApi.renameApp(scope, renamingAppId, draftAppName.trim())
      setConfig(updated)
      setRenamingAppId(null)
      toast({ title: 'Application renamed' })
    } catch (error) {
      toast({
        title: 'Rename failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setRenamingSaving(false)
    }
  }

  const handleRemoveApp = async (app: MurgaaApp) => {
    if (!window.confirm(`Remove "${app.name}"? This deletes the uploaded file.`)) return
    setRemovingAppId(app.id)
    try {
      const updated = await murgaaApi.removeApp(scope, app.id)
      setConfig(updated)
      if (renamingAppId === app.id) setRenamingAppId(null)
      toast({ title: 'Application removed' })
    } catch (error) {
      toast({
        title: 'Could not remove application',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setRemovingAppId(null)
    }
  }

  // `updatedAt` doubles as the cache-buster so a re-upload repaints the preview.
  const imageSrc = config?.hasImage ? murgaaApi.imageUrl(scope, config.updatedAt) : null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <DialogTitle>Murgaa</DialogTitle>
                <DialogDescription>
                  {scope === 'script'
                    ? 'Script generation reference'
                    : scope === 'voice'
                    ? 'Voice generation reference'
                    : 'Image Clipper 3.0 reference'}
                </DialogDescription>
              </div>
              <Button
                variant={editing ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => {
                  setDraftDescription(config?.description ?? '')
                  setEditing(e => !e)
                }}
              >
                <Pencil className="h-4 w-4 mr-2" />
                {editing ? 'Done' : 'Edit'}
              </Button>
            </div>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading…
            </div>
          ) : (
            <div className="space-y-4">
              {/* 1. Image preview */}
              <div>
                <div className="relative rounded-md border bg-muted/30 overflow-hidden group">
                  {imageSrc ? (
                    <>
                      <img
                        src={imageSrc}
                        alt={config?.imageName || 'Murgaa reference'}
                        className="w-full max-h-64 object-contain bg-background cursor-zoom-in"
                        onClick={() => setFullscreen(true)}
                      />
                      <Button
                        variant="secondary"
                        size="icon"
                        className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="View fullscreen"
                        onClick={() => setFullscreen(true)}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-10 text-muted-foreground text-sm gap-2">
                      <ImageIcon className="h-8 w-8" />
                      No image configured
                    </div>
                  )}
                </div>

                {editing && (
                  <div className="mt-2">
                    <input
                      id={`murgaa-image-${scope}`}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) handleImageUpload(file)
                        e.target.value = ''
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={uploadingImage}
                      onClick={() => document.getElementById(`murgaa-image-${scope}`)?.click()}
                    >
                      {uploadingImage ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4 mr-2" />
                      )}
                      {config?.hasImage ? 'Replace image' : 'Upload image'}
                    </Button>
                  </div>
                )}
              </div>

              <Separator />

              {/* 2. Description */}
              {editing ? (
                <div className="space-y-2">
                  <Label htmlFor={`murgaa-desc-${scope}`}>Description</Label>
                  <Textarea
                    id={`murgaa-desc-${scope}`}
                    rows={3}
                    value={draftDescription}
                    placeholder="Add a short description…"
                    onChange={e => setDraftDescription(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={saving || draftDescription === config?.description}
                    onClick={handleSaveDescription}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Save description
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {config?.description || 'No description yet.'}
                </p>
              )}

              <Separator />

              {/* 3. Applications — a list, each independently launched, and
                  (in edit mode) renamed or removed. */}
              <div className="space-y-2">
                {config && config.apps.length === 0 && (
                  <p className="text-sm text-muted-foreground">No applications uploaded yet.</p>
                )}

                {config?.apps.map(app => (
                  <div key={app.id} className="flex items-center gap-2">
                    {renamingAppId === app.id ? (
                      <>
                        <Input
                          autoFocus
                          value={draftAppName}
                          onChange={e => setDraftAppName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleRenameApp()
                            if (e.key === 'Escape') setRenamingAppId(null)
                          }}
                          className="h-8 text-sm"
                        />
                        <Button
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          disabled={renamingSaving || !draftAppName.trim()}
                          onClick={handleRenameApp}
                          title="Save name"
                        >
                          {renamingSaving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => setRenamingAppId(null)}
                          title="Cancel"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        {app.missing ? (
                          <div className="flex-1 flex items-center gap-2 text-sm text-destructive min-w-0">
                            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                            <span className="truncate">{app.name} — file missing from disk</span>
                          </div>
                        ) : (
                          <Button
                            variant="link"
                            className="h-auto p-0 text-base flex-1 justify-start min-w-0"
                            disabled={launchingAppId === app.id}
                            onClick={() => handleLaunch(app)}
                          >
                            {launchingAppId === app.id ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin flex-shrink-0" />
                            ) : (
                              <ExternalLink className="h-4 w-4 mr-2 flex-shrink-0" />
                            )}
                            <span className="truncate">{app.name}</span>
                          </Button>
                        )}

                        {editing && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 flex-shrink-0"
                              onClick={() => startRenaming(app)}
                              title="Rename"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 flex-shrink-0 text-destructive hover:text-destructive"
                              onClick={() => handleRemoveApp(app)}
                              disabled={removingAppId === app.id}
                              title="Remove"
                            >
                              {removingAppId === app.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}

                {editing && (
                  <>
                    <input
                      id={`murgaa-app-${scope}`}
                      type="file"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) handleAddApp(file)
                        e.target.value = ''
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={addingApp}
                      onClick={() => document.getElementById(`murgaa-app-${scope}`)?.click()}
                    >
                      {addingApp ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4 mr-2" />
                      )}
                      Add application
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Fullscreen image viewer — a plain overlay so the image is not boxed
          into the dialog's max width. */}
      {fullscreen && imageSrc && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setFullscreen(false)}
        >
          <img
            src={imageSrc}
            alt={config?.imageName || 'Murgaa reference'}
            className="max-w-full max-h-full object-contain"
            onClick={e => e.stopPropagation()}
          />
          <Button
            variant="secondary"
            size="icon"
            className="absolute top-4 right-4"
            title="Close"
            onClick={() => setFullscreen(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      )}
    </>
  )
}
