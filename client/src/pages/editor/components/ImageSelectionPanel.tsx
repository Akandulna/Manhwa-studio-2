/**
 * ImageSelectionPanel — the focused part's chapter crop pool. Click a crop to
 * select/deselect it for the part (order is auto by crop number). A black-filler
 * button adds a blank slot.
 */

import { useEffect, useState } from 'react'
import { videoApi, type ChapterCrop } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Square, Check, Sparkles } from 'lucide-react'

interface Props {
  chapterId: string
  selectedCropIds: Set<string>
  onToggleCrop: (crop: ChapterCrop) => void
  onAddFiller: () => void
  onSuggest?: () => void
  suggesting?: boolean
  aiAvailable?: boolean
}

// Small in-memory cache so re-focusing a part doesn't refetch every time.
const cropCache = new Map<string, ChapterCrop[]>()

export default function ImageSelectionPanel({ chapterId, selectedCropIds, onToggleCrop, onAddFiller, onSuggest, suggesting, aiAvailable }: Props) {
  const [crops, setCrops] = useState<ChapterCrop[]>(cropCache.get(chapterId) || [])
  const [loading, setLoading] = useState(!cropCache.has(chapterId))

  useEffect(() => {
    if (cropCache.has(chapterId)) {
      setCrops(cropCache.get(chapterId)!)
      setLoading(false)
      return
    }
    setLoading(true)
    videoApi.getChapterCrops(chapterId)
      .then(data => {
        cropCache.set(chapterId, data)
        setCrops(data)
      })
      .catch(err => console.error('Error loading crops:', err))
      .finally(() => setLoading(false))
  }, [chapterId])

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Crop Pool</h3>
          <p className="text-xs text-muted-foreground">{crops.length} crops · click to select</p>
        </div>
        <div className="flex items-center gap-1.5">
          {aiAvailable && onSuggest && (
            <Button size="sm" variant="outline" onClick={onSuggest} disabled={suggesting} title="Suggest images with AI">
              {suggesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
              Suggest
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onAddFiller}>
            <Square className="h-3.5 w-3.5 mr-1" />
            Filler
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : crops.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground text-center p-4">
          No finalized crops for this chapter.
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {/* Row-major grid so crops read left-to-right in numerical order
              (#1, #2, #3 …). Each cell keeps its natural aspect ratio (the full
              image is shown, top-aligned) rather than being cropped to a fixed
              height. Fewer columns on narrow widths keeps the thumbnails large. */}
          <div className="grid grid-cols-2 2xl:grid-cols-3 gap-2 p-3 items-start">
            {crops.map(crop => {
              const isSelected = selectedCropIds.has(crop.id)
              return (
                <button
                  key={crop.id}
                  onClick={() => onToggleCrop(crop)}
                  className={`relative block w-full rounded overflow-hidden border-2 transition-colors ${
                    isSelected ? 'border-primary' : 'border-transparent hover:border-primary/40'
                  }`}
                >
                  <img
                    src={videoApi.cropImageUrl(crop.id)}
                    alt={`Crop ${crop.sequence}`}
                    className="w-full h-auto object-contain bg-neutral-900"
                    loading="lazy"
                    draggable={false}
                  />
                  <span className="absolute top-1 left-1 bg-black/70 text-white text-[10px] px-1.5 rounded">
                    #{crop.sequence}
                  </span>
                  {isSelected && (
                    <span className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full p-0.5">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
