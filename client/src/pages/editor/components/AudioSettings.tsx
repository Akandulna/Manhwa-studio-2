/**
 * AudioSettings — project audio mix: pick a background music track (looped under
 * the narration) and set the master + BG-music volume levels.
 */

import { useEffect, useState } from 'react'
import { videoApi, type VideoProject, type MusicTrack } from '@/lib/api'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select'

const NONE = '__none__'

interface Props {
  project: VideoProject
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (patch: { musicTrackId: string | null; masterVolume: number; musicVolume: number }) => Promise<void>
}

export default function AudioSettings({ project, open, onOpenChange, onSave }: Props) {
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [musicTrackId, setMusicTrackId] = useState<string>(project.musicTrackId ?? NONE)
  const [master, setMaster] = useState(project.masterVolume)
  const [music, setMusic] = useState(project.musicVolume)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) videoApi.listMusic().then(setTracks).catch(() => {})
  }, [open])

  async function save() {
    setSaving(true)
    try {
      await onSave({
        musicTrackId: musicTrackId === NONE ? null : musicTrackId,
        masterVolume: master,
        musicVolume: music
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Audio &amp; Music</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Background music</Label>
            <Select value={musicTrackId} onValueChange={setMusicTrackId}>
              <SelectTrigger><SelectValue placeholder="No music" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No music</SelectItem>
                {tracks.map(t => <SelectItem key={t.id} value={t.id}>{t.filename}</SelectItem>)}
              </SelectContent>
            </Select>
            {tracks.length === 0 && (
              <p className="text-[11px] text-muted-foreground">Upload tracks in the Music library.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between">
              <Label className="text-xs">Master volume</Label>
              <span className="text-xs text-muted-foreground">{Math.round(master * 100)}%</span>
            </div>
            <Slider min={0} max={1} step={0.05} value={[master]} onValueChange={([v]) => setMaster(v)} />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between">
              <Label className="text-xs">Background music level</Label>
              <span className="text-xs text-muted-foreground">{Math.round(music * 100)}%</span>
            </div>
            <Slider min={0} max={1} step={0.05} value={[music]} onValueChange={([v]) => setMusic(v)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
