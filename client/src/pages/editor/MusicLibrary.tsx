/**
 * MusicLibrary — Module 4: global background-music library. Upload tracks
 * (stored locally), preview, and delete. Projects pick one track in the editor.
 */

import { useEffect, useRef, useState } from 'react'
import { videoApi, type MusicTrack } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { Music, Upload, Trash2, Loader2 } from 'lucide-react'

export default function MusicLibrary() {
  const { toast } = useToast()
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function load() {
    videoApi.listMusic()
      .then(setTracks)
      .catch(err => console.error(err))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      await videoApi.uploadMusic(file)
      toast({ title: 'Uploaded', description: file.name })
      load()
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function remove(track: MusicTrack) {
    try {
      await videoApi.deleteMusic(track.id)
      setTracks(prev => prev.filter(t => t.id !== track.id))
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Music className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Music Library</h1>
        </div>
        <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
          Upload track
        </Button>
        <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={onUpload} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : tracks.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Music className="h-16 w-16 mx-auto mb-4 opacity-30" />
          <p>No music yet. Upload a track to use as background music under your videos.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tracks.map(track => (
            <Card key={track.id}>
              <CardContent className="p-3 flex items-center gap-3">
                <Music className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="flex-1 truncate text-sm font-medium">{track.filename}</span>
                <audio controls src={videoApi.musicFileUrl(track.id)} className="h-8" />
                <Button variant="ghost" size="icon" onClick={() => remove(track)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
