/**
 * Page Stitcher grouping. A layout is a list of groups, each an ordered list
 * of page indices; every group whose pages are not all excluded becomes one
 * stitched page. Auto grouping fills groups in reading order; the user can
 * then split, join and drag images anywhere, so a group may be out of order.
 * Heights follow the server: every page in a group is scaled to the group's
 * widest page and stacked.
 */

export interface PlanPage {
  filename: string
  width: number
  height: number
}

export type Groups = number[][]

/** Where dragged images land: inside a group at a position, or as a new group. */
export type DropTarget = { group: number; index: number } | { newGroupAt: number }

/** Size of the page stitched from `pages` — widest width, scaled heights summed. */
export function stitchedSize(pages: PlanPage[]): { width: number; height: number } {
  if (pages.length === 0) return { width: 0, height: 0 }
  const width = Math.max(...pages.map(p => p.width))
  const height = pages.reduce((sum, p) => sum + Math.round((p.height * width) / p.width), 0)
  return { width, height }
}

/**
 * Greedy grouping in reading order: fill each output page up to `target` px,
 * starting a new one when the next page would go over. A page taller than the
 * target on its own still gets a page of its own. Excluded pages add no height.
 */
export function autoGroups(pages: PlanPage[], excluded: ReadonlySet<string>, target: number): Groups {
  const groups: Groups = []
  let kept: PlanPage[] = []
  pages.forEach((page, i) => {
    if (groups.length === 0) groups.push([])
    if (!excluded.has(page.filename)) {
      if (kept.length > 0 && stitchedSize([...kept, page]).height > target) {
        groups.push([])
        kept = []
      }
      kept.push(page)
    }
    groups[groups.length - 1].push(i)
  })
  return groups
}

/** Split group `g` so its item at `index` starts a new group. */
export function splitGroup(groups: Groups, g: number, index: number): Groups {
  const group = groups[g]
  if (!group || index <= 0 || index >= group.length) return groups
  return [...groups.slice(0, g), group.slice(0, index), group.slice(index), ...groups.slice(g + 1)]
}

/** Append group `g` to the one before it. */
export function joinWithPrevious(groups: Groups, g: number): Groups {
  if (g <= 0 || g >= groups.length) return groups
  return [...groups.slice(0, g - 1), [...groups[g - 1], ...groups[g]], ...groups.slice(g + 1)]
}

/**
 * Move `moving` page indices to `target` (positions refer to the layout
 * before the move). The moved pages keep the order they have in the layout;
 * groups left empty disappear.
 */
export function moveImages(groups: Groups, moving: number[], target: DropTarget): Groups {
  const set = new Set(moving)
  if (set.size === 0) return groups
  const ordered = groups.flat().filter(i => set.has(i))

  // Remove the moved pages but keep empty groups so target positions stay valid.
  const next = groups.map(group => group.filter(i => !set.has(i)))

  if ('newGroupAt' in target) {
    next.splice(Math.max(0, Math.min(target.newGroupAt, next.length)), 0, ordered)
  } else {
    const source = groups[target.group]
    if (!source) return groups
    // Count only the pages that stay, so the slot is the one the user pointed at.
    const at = source.slice(0, target.index).filter(i => !set.has(i)).length
    next[target.group].splice(at, 0, ...ordered)
  }
  return next.filter(group => group.length > 0)
}

/** Groups containing a page that comes earlier in the book than the page before it. */
export function outOfOrderGroups(groups: Groups, isExcluded: (index: number) => boolean): Set<number> {
  const flagged = new Set<number>()
  let last = -1
  groups.forEach((group, g) => {
    for (const i of group) {
      if (isExcluded(i)) continue
      if (i < last) flagged.add(g)
      last = i
    }
  })
  return flagged
}

/** The `groups` body the server stitches: one filename list per output page. */
export function outputGroups(pages: PlanPage[], groups: Groups, excluded: ReadonlySet<string>): string[][] {
  return groups
    .map(group => group.map(i => pages[i].filename).filter(name => !excluded.has(name)))
    .filter(group => group.length > 0)
}
