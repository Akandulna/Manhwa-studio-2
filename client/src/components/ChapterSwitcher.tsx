import { useNavigate } from 'react-router-dom'
import { ChapterNeighbours } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Previous / next downloaded chapter of the same series. `to` builds the route
 * for a chapter id; `canLeave` can veto the switch (e.g. unsaved edits).
 */
export default function ChapterSwitcher({
  neighbours,
  to,
  canLeave
}: {
  neighbours: ChapterNeighbours
  to: (chapterId: string) => string
  canLeave?: () => boolean
}) {
  const navigate = useNavigate()
  const go = (chapterId: string) => {
    if (canLeave && !canLeave()) return
    navigate(to(chapterId))
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <Button
        variant="outline"
        size="sm"
        disabled={!neighbours.prev}
        title={neighbours.prev ? `Chapter ${neighbours.prev.number}` : 'No earlier downloaded chapter'}
        onClick={() => neighbours.prev && go(neighbours.prev.id)}
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        {neighbours.prev ? `Ch ${neighbours.prev.number}` : 'Previous'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!neighbours.next}
        title={neighbours.next ? `Chapter ${neighbours.next.number}` : 'No later downloaded chapter'}
        onClick={() => neighbours.next && go(neighbours.next.id)}
      >
        {neighbours.next ? `Ch ${neighbours.next.number}` : 'Next'}
        <ChevronRight className="h-4 w-4 ml-1" />
      </Button>
    </div>
  )
}
