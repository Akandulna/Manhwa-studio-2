import { prisma } from '../index.js'

export interface ChapterNeighbour {
  id: string
  number: number
}

/** The downloaded chapters either side of this one in its series, for prev/next buttons. */
export async function doneNeighbours(
  seriesId: string,
  number: number
): Promise<{ prev: ChapterNeighbour | null; next: ChapterNeighbour | null }> {
  const select = { id: true, number: true }
  const [prev, next] = await Promise.all([
    prisma.chapter.findFirst({
      where: { seriesId, status: 'done', number: { lt: number } },
      orderBy: { number: 'desc' },
      select
    }),
    prisma.chapter.findFirst({
      where: { seriesId, status: 'done', number: { gt: number } },
      orderBy: { number: 'asc' },
      select
    })
  ])
  return { prev, next }
}
