/**
 * The static text of the phone's geometry-only ("Classic") crop-pointer prompts, as editable templates.
 *
 * Studio can store edited versions in settings; rendering a DEFAULT template with real values gives the
 * phone's prompt byte for byte. A slot is written `{{NAME}}` (capitals, digits, underscores). Rendering is
 * one pass, so a value that itself contains `{{…}}` is never expanded again; an unknown slot is left as
 * written.
 *
 * Sources (Sleeper-Cell, branch v2):
 * - DEFAULT_CROP_RULES ........ data/BrowserDatabase.kt `CROP_RULES_PROMPT` (the fixed "Crop Rules" prompt)
 * - CONTINUITY_RULES, REVIEW_RULES ... clipper/CropSceneRules.kt
 * - DEFAULT_ANALYSIS_TEMPLATE . clipper/GeometryWorkflow.kt `prompt(h)`
 * - DEFAULT_REVIEW_TEMPLATE ... clipper/CropReview.kt `geometryReviewPrompt(…, fresh = false, annotatedImages = false)`
 */

/** Twelve spaces: see DEFAULT_ANALYSIS_TEMPLATE. */
const K = '            '

/**
 * SHOT CONTINUITY rules, shared by the analysis and review prompts (CropSceneRules.continuity).
 */
export const CONTINUITY_RULES = [
  'SHOT CONTINUITY — apply before choosing crop boundaries',
  '- One continuous composition stays ONE crop, including all characters and objects sharing it. Start with real drawn panel borders and gutters. Separate unframed shots only when there is a visible artwork break or a distinct camera view/inset, not merely a change of subject, scale, expression, shading or background within the same composition.',
  "- Never place an internal boundary through a continuous face, hair, body, hand, clothing or object to create two crops. A child's hair above and face/body below are one shot; attendants behind a child are one group shot; a hand and the object it interacts with remain together in one continuous scene.",
  "- A head, hair, hand, body or SFX that breaks out past a panel's drawn border belongs to that panel: one crop holds the panel and its pop-out. The frame line the figure crosses is not a split, and a change of background pattern or effect inside one panel is not one either.",
  '- Two crops never meet edge to edge on one line unless a drawn panel border, gutter or clear artwork break runs along that whole line. If you are about to end one crop exactly where the next begins, check that line first: when the same figure, object or panel continues across it, make it one crop.',
  '- A slice seam, image edge between uploads, top/middle/bottom hint, crop label, target crop count or aspect ratio is not a drawn panel boundary. Keep a continuous shot whole across slices, however tall it is.',
  '- Speech bubbles, narration and SFX never justify a crop or a split.',
  '- Before accepting separate crops, trace the proposed dividing edge on the source artwork. If subject outlines or the same composition continue across it without a real shot boundary, use one enclosing crop. Matching backgrounds alone do not prove continuity: retain separate panels and genuine distinct shots.',
  '- Size and height checks request inspection, never a split. If the boundary cannot be verified, keep the complete continuous composition and flag boundary_uncertain rather than inventing a cut.',
].join('\n')

/** The adjacent-crop audit paragraph of the review prompt (CropSceneRules.review). */
export const REVIEW_RULES =
  'ADJACENT-CROP AUDIT: inspect every shared or nearby edge between proposed crops, even when neither has an automatic check. The coloured boxes and their labels are proposals, not panel borders. If two boxes divide the same head, body, hand/object interaction, group composition or framed panel, merge them into one complete shot: keep one key and list the other keys in from_keys. A SHARED_EDGE check means two boxes meet with no gutter: merge them unless you can see a drawn panel border, gutter or clear artwork break along that line, and only then tick its token. Trace the source artwork before keeping the split; preserve genuine separate panels and insets. Review the merged crop as a whole even if its height triggers a size check.'

/**
 * The analysis (Crop Pointer) prompt, GeometryWorkflow.prompt(h). `withRules` puts the crop rules ahead of it.
 *
 * The 12-space indents are deliberate. Kotlin interpolates the template first and runs trimIndent() on the
 * result; the interpolated continuity rules and second-and-later slice lines start at column 0, so the
 * common indent is 0 and every template line keeps its 12 spaces while the inserted lines have none.
 *
 * Slots:
 * - {{CONTINUITY_RULES}}   the SHOT CONTINUITY block (CONTINUITY_RULES unless overridden)
 * - {{SLICE_LINES}}        one line per slice, "<id>: <width>x<height>, original page y=<y0>..<y1>", joined by "\n"
 * - {{ANALYSIS_SCHEMA}}    "chatgpt-analysis/1.0"
 * - {{JOB_ID}}             handoff.jobId (inserted raw, not JSON-escaped, as on the phone)
 * - {{SOURCE_SHA256}}      handoff.source.sha256
 * - {{PAGE_STEM}}          handoff.source.pageStem (raw)
 * - {{SOURCE_WIDTH}}       handoff.source.width
 * - {{SOURCE_HEIGHT}}      handoff.source.height
 * - {{COORDINATE_SYSTEM}}  "slice_local_pixels"
 * - {{FIRST_SLICE_ID}}     handoff.slices[0].id
 * - {{FIRST_SLICE_HEIGHT}} handoff.slices[0].height
 */
export const DEFAULT_ANALYSIS_TEMPLATE = [
  `${K}Find every illustrated shot in this ONE page and measure its rectangle. This is geometry-only clipping: do not create descriptions or script associations.`,
  `${K}{{CONTINUITY_RULES}}`,
  `${K}Inspect all attached slices top to bottom, left to right. A slice seam is never a shot boundary. Exclude isolated bubbles, captions and SFX over filler backgrounds.`,
  `${K}Corners use slice-local integer pixels; bottom_right is exclusive. Each corner identifies the slice it falls in. A crop may span slices.`,
  `${K}{{SLICE_LINES}}`,
  `${K}Return JSON only: {"schema_version":"{{ANALYSIS_SCHEMA}}","job_id":"{{JOB_ID}}","source_sha256":"{{SOURCE_SHA256}}","page_stem":"{{PAGE_STEM}}","source_width":{{SOURCE_WIDTH}},"source_height":{{SOURCE_HEIGHT}},"coordinate_system":"{{COORDINATE_SYSTEM}}","page_inspection_complete":true,"page_review_flags":[],"candidates":[{"candidate_id":"candidate-01","reason":"illustrated_shot","top_left":{"slice_id":"{{FIRST_SLICE_ID}}","x":0,"y":0},"bottom_right":{"slice_id":"{{FIRST_SLICE_ID}}","x":{{SOURCE_WIDTH}},"y":{{FIRST_SLICE_HEIGHT}}},"visual_evidence":"Visible shot boundary","review_flags":[]}]}`,
  `${K}The candidate above is an example, not a target crop. Return an empty candidates array only for a page with no eligible artwork. Never invent an internal shot boundary.`,
].join('\n')

/**
 * The geometry-only review round sent in the SAME conversation as the analysis (Classic flow:
 * geometryReviewPrompt with fresh = false, annotatedImages = false). The phone sends it without crop rules.
 *
 * Slots:
 * - {{PAGE_STEM}}          handoff.source.pageStem
 * - {{IMAGES}}             REVIEW_IMAGES_SLICES, or REVIEW_IMAGES_WHOLE_PAGE for a whole-page handoff
 * - {{CONTINUITY_RULES}}   the SHOT CONTINUITY block
 * - {{REVIEW_RULES}}       the ADJACENT-CROP AUDIT paragraph
 * - {{SWEEP_LINES}}        the inked uncovered stretches ("  <slice> y <y> → <slice> y <y> (<n>% ink)" each, or
 *                          "  (none)"), then the count of quiet stretches when there are any; joined by "\n"
 * - {{MEASURING}}          REVIEW_MEASURING_SLICES, or "MEASURING: " + WHOLE_PAGE_COORDINATES for a whole page
 * - {{JOB_ID}}             handoff.jobId
 * - {{SOURCE_SHA256}}      handoff.source.sha256
 * - {{REVIEW_REVISION}}    state.revision
 * - {{REVIEW_SCHEMA}}      "clipper-review-geometry/1.0"
 * - {{EXAMPLE_JSON}}       the reply example, Json.stringify(pretty = true)
 * - {{CURRENT_CROPS_JSON}} the current crops with slice-local corners and checks, Json.stringify(pretty = true)
 */
export const DEFAULT_REVIEW_TEMPLATE = [
  'REVIEW ROUND for "{{PAGE_STEM}}"',
  '',
  '{{IMAGES}}',
  '',
  'Below are the crops currently proposed for this page. Act as the reviewer. Compare every crop with the page and decide its FINAL form:',
  '- keep it exactly (same corners),',
  '- adjust its corners so it holds the complete shot — whole faces, hands, weapons, effects — and nothing from the neighbouring shot; trim any top or bottom stretch that is only bubbles, narration, a caption/system text window or empty background (the edge goes where the artwork starts and ends),',
  '- split it when it actually contains separate shots (return each part as a new crop with "from_keys": [its key]),',
  '- merge crops that are really one continuous shot (return one crop with "key" = one of them and "from_keys" = the others),',
  '- remove it (list its key in "removed_keys") when it is not an independently readable illustrated moment.',
  '{{CONTINUITY_RULES}}',
  '{{REVIEW_RULES}}',
  'ALWAYS remove a crop whose content is only speech/thought/narration bubbles, caption boxes or SFX over a plain, gradient, sky, sparkle, particle, glow or speed-line background, even if its checks pass.',
  '',
  'CHECKS: each crop lists automatic checks with a token. Look at what each one points to. If the crop is fine despite it (or after your fix), put its token in "checks_reviewed". Leave a token out if you could not verify it.',
  '',
  'SWEEP: go through the whole page top to bottom, independently of the crops below, for artwork no crop holds — small inserts, grayscale panels, objects, landscapes, effects shots. These uncovered stretches are inked enough to hold artwork:',
  '{{SWEEP_LINES}}',
  'Add a crop (key null, no from_keys) for any real artwork there. Ink includes bubbles and lettering: a stretch holding only bubbles, narration or SFX over background stays uncovered. Set "sweep_done": true only after you have actually swept the page.',
  '',
  'DESCRIPTIONS: write none. Descriptions and story associations are generated later by the separate AI Studio Metadata flow. Return crop geometry only.',
  '',
  '{{MEASURING}}',
  '',
  'RULES FOR THE REPLY:',
  '- "crops" is the COMPLETE final list for the page.',
  '- Every current key must appear exactly once: as a crop\'s "key", inside a "from_keys", or in "removed_keys".',
  '- Copy job_id, source_sha256 and review_revision exactly: {{JOB_ID}} / {{SOURCE_SHA256}} / {{REVIEW_REVISION}}.',
  '- Return ONE JSON object ({{REVIEW_SCHEMA}}), no prose, no Markdown fences. Shape (example values):',
  '{{EXAMPLE_JSON}}',
  '',
  'CURRENT CROPS:',
  '{{CURRENT_CROPS_JSON}}',
].join('\n')

/** {{IMAGES}} for a sliced page. Slots: {{SLICE_COUNT}}, {{SLICE_IDS}} (", "-joined), {{SOURCE_WIDTH}}, {{SOURCE_HEIGHT}}. */
export const REVIEW_IMAGES_SLICES =
  'Use the {{SLICE_COUNT}} slices of this page already attached earlier in this conversation ({{SLICE_IDS}}, {{SOURCE_WIDTH}}×{{SOURCE_HEIGHT}} px in total).'

/** {{IMAGES}} for a whole-page handoff. Slots: {{SOURCE_WIDTH}}, {{SOURCE_HEIGHT}}. */
export const REVIEW_IMAGES_WHOLE_PAGE =
  'Use the ONE original whole page already attached earlier in this conversation ({{SOURCE_WIDTH}}×{{SOURCE_HEIGHT}} px).'

/** {{MEASURING}} for a sliced page. */
export const REVIEW_MEASURING_SLICES =
  'MEASURING: corners are in the pixel grid of the slice each corner falls in — { "slice_id", "x", "y" } — exactly as in your first answer. bottom_right is exclusive. Whole pixels only.'

/**
 * HandoffFormat.wholePageCoordinates: a whole page keeps the slice JSON contract with zero offsets.
 * Slots: {{SLICE_ID}} (the one slice), {{SOURCE_WIDTH}}, {{SOURCE_HEIGHT}}, {{COORDINATE_SYSTEM}}.
 */
export const WHOLE_PAGE_COORDINATES =
  'Use slice_id "{{SLICE_ID}}" for every corner: it identifies the ONE whole page, not a split image. ' +
  'Measure x from 0 to {{SOURCE_WIDTH}} and y from 0 to {{SOURCE_HEIGHT}} in ORIGINAL page pixels, ' +
  "even if the viewer displays a resized preview. The origin (0, 0) is the page's top-left; there are no slice offsets. " +
  'Keep coordinate_system "{{COORDINATE_SYSTEM}}" as required by the JSON contract. bottom_right is exclusive. Whole pixels only.'

/**
 * Fills `{{NAME}}` slots in one pass. Values are inserted as is; a slot without a value is left untouched.
 */
export function renderTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (slot, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : slot,
  )
}

/** The `{{NAME}}` slots a (possibly edited) template uses, in first-use order. */
export function templateSlots(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]!))]
}

/**
 * The fixed "Crop Rules" prompt the phone seeds into its Prompt library (BrowserDatabase CROP_RULES_PROMPT,
 * after trimIndent). withRules() puts it ahead of the analysis prompt.
 */
export const DEFAULT_CROP_RULES = `CROP RULES

A. Source geometry
1. Work in the original page's pixel coordinate system. Read width and
   height from image bytes or a verified manifest, not apparent display size.
2. Ordered, contiguous, nonoverlapping slices with equal widths form one
   logical page: W = slice width; H = sum of slice heights; each slice's
   y origin is the sum of all earlier slice heights. Do not resize them.
3. Analysis windows that overlap are different from source slices. Their
   origins come from the manifest; never sum their heights to obtain H.
   Do not count overlap twice. A context-only overview adds no page pixels.
4. For unequal widths, missing sections, unknown order, or uncertain overlap,
   require the original page or a verified placement/transform manifest.
   Do not silently stretch, align, remove, or invent source pixels.
5. Slice/window edges are not scene boundaries. Inspect both sides of every
   seam. Request or construct an expanded view for a scene crossing a seam.

B. What deserves a crop
6. A crop contains a complete, independently readable illustrated moment:
   a framed panel, a distinct shot in continuous artwork, or a coherent
   environment, object, or effects shot that carries visual content.
7. Start with real drawn panel borders, gutters, and artwork extents. One
   continuous composition stays one crop. Separate unframed shots require
   a visible artwork break or distinct camera view/inset. A change of subject,
   scale, expression, shading or lighting within that composition is not
   enough. Geometric proposals are provisional and may miss artwork.
8. Several characters sharing one shot remain one crop, including foreground
   and background figures. A child's hair, face and body are not separate
   shots; a hand and the object it interacts with stay together in one scene.
   Multiple separate shots must not remain merged just because they share
   a dark background. Preserve real separate panels and illustrated insets.
9. Keep meaningful grayscale artwork, small illustrated inserts, establishing
   shots, landscapes, and object shots. Lack of color or people is not a
   rejection rule. Do not invent a minimum crop count or target aspect ratio.
10. Exclude blank gutters, standalone credits/logos, text-only regions with
    no meaningful artwork, and transition strips: a plain, dark, gradient or
    textured background, glow, particles, or speed lines with no person,
    creature, object, or place as the subject (an effect that is itself the
    shot's subject still counts, see 15). Do not crop more tightly merely to
    force an image into 16:9; later video composition handles aspect ratio.

C. Resolve each rectangle independently
11. Determine left, right, top, and bottom from that crop's own artwork.
    Do not inherit a neighboring crop's width. Identical X values are valid
    when the artwork really is aligned or full-width.
12. Preserve meaningful artwork protruding beyond a frame: faces, hands,
    weapons, clothing, and relevant effects. Where a subject was already cut
    off by the original artwork, do not invent or reconstruct its continuation.
13. For angled panels, use the smallest safe axis-aligned rectangle enclosing
    the intended art. Some background in its corners is acceptable. If that
    rectangle necessarily includes a neighbor, retain the safe rectangle and
    flag the limitation instead of clipping important artwork to hide it.
14. Speech bubbles, narration boxes, and SFX do not seed crops, connect two
    crops, determine the crop's outer extent, or justify a split. A crop's top
    and bottom follow its artwork: a bubble, narration box, or caption/system
    text window sitting above or below the art stays outside the crop. Retain
    their pixels when they lie inside the chosen rectangle. Do not erase,
    inpaint, or extend a rectangle solely to preserve an overlay beyond the
    artwork.
15. An SFX-only strip is not a separate crop. Associate it with a neighboring
    scene only when that scene's artwork continues into the strip. Background
    magic, smoke, impact effects, and motion fields can be genuine artwork;
    distinguish them from lettering by looking.
16. Preserve useful breathing room without adding large empty margins. Use a
    real gutter when available; never make a subject-touching cut merely to
    remove all whitespace.

D. Mandatory scene and coverage audit
17. Audit every crop for accidental merging, even if its geometry looks valid.
    Take an additional close look if height > 2 times its width, height > 20%
    of page height, height > 2.5 times the median of the OTHER crop heights,
    or more than one distinct shot is visible. Skip the median test if no
    meaningful comparison exists. These are review triggers, not split rules.
18. Locate visual anchors: people, faces, hands, objects, environment details,
    and action focal points. Group them by shot, then place boundaries in
    safe intervening space. For an unframed transition, end each crop where
    its own artwork ends: the neutral gap between two shots belongs to
    neither crop, so do not split it down the middle. Inspect the gap at
    higher detail.
19. Confirm every proposed split by tracing its boundary on the source:
    require a real panel border, gutter, artwork discontinuity or distinct
    camera view/inset. Never divide a continuous face, hair, body, hand,
    clothing or object into fragments. Empty skin/hair-color masks,
    subject/scale changes within one composition, similar-colored backgrounds,
    speech, and SFX alone are insufficient. Fixed color thresholds are
    optional proposals only.
20. Keep a continuous falling figure, tall structure, panorama, or single
    action beat whole. Do not split a scene just to satisfy size thresholds.
    If coherent shots cannot be safely separated, keep the safe larger crop
    and mark it for review.
21. Sweep the source page from top to bottom independently of the candidate
    list. Look for omitted small inserts, grayscale scenes, inset panels,
    uncovered artwork, duplicated scenes, seam cuts, and accidental fragments.
    Do not require whitespace and excluded overlays to be covered by crops.
22. Compare crop previews against the source page. A crop-only review cannot
    discover a missing crop elsewhere on the page. Inspect every shared or
    nearby crop edge, even without an automatic warning: crop boxes and
    labels are not panel borders. Merge adjacent fragments of one continuous
    composition into one enclosing crop. Overlap between output
    rectangles may be legitimate for protruding artwork or angled panels;
    inspect it instead of deleting overlapping crops automatically.
23. Keep an internal factual audit record when the runner supports it:
    candidate bounds, audit trigger, visible subject/shot evidence, boundary
    method, split/keep decision, and remaining uncertainty. This is a job log,
    not an extra field in either public JSON file. Do not claim recorded
    measurements or persisted audit logs unless they actually exist.

E. Finalization and pointer output
24. Assign IDs only after combining all views, resolving overlap duplicates,
    and finalizing the crop list. Sort primarily top to bottom. For genuine
    side-by-side panels, use the supplied reading direction. Default is
    left-to-right for this workflow; explicit page layout takes precedence.
25. Use crop-01, crop-02, and so on, contiguous and 1-based. Use at least two
    digits; do not truncate if a page exceptionally has more than 99 crops.
26. Give each crop a short factual snake_case reason, e.g. framed_reaction,
    object_closeup, or environment_shot. For a verified distinct-shot split
    append __subject_split; for a tall crop checked and retained append
    __audited_continuous; for unresolved visual uncertainty append __review.
    Keep the complete label concise. Freeze it before export naming.
27. Establish integer pixel edges first, using left/top inclusive and
    right/bottom exclusive rectangles: 0 <= x0 < x1 <= W and
    0 <= y0 < y1 <= H. All four points come from these SAME four edges.
28. Normalize once, against the complete source page: X0=x0/W, X1=x1/W,
    Y0=y0/H, Y1=y1/H. For a view, map its coordinates to the source page first.
    Never use slice height, tile height, or screenshot width as denominators.
29. Emit coordinates as finite JSON numbers in [0,1], never strings, nulls,
    booleans, NaN, or Infinity. Reuse shared edge values exactly. Round only
    at final serialization, to at most nine decimal places. Check that no
    nonzero crop collapsed after rounding. Do not clamp invalid geometry to
    make it pass; correct the mapping or report the error.
30. Pointer JSON has exactly this structure, repeated for all final crops:
    {
      "format": "four-point-crop",
      "version": "1.0",
      "image": {"filename": PAGE_FILENAME, "width": W, "height": H},
      "coordinateSystem": "normalized",
      "crops": [
        {
          "id": "crop-01",
          "reason": REASON,
          "crop": {
            "mode": "rectangle",
            "points": [
              {"id": "P1", "x": X0, "y": Y0},
              {"id": "P2", "x": X1, "y": Y0},
              {"id": "P3", "x": X1, "y": Y1},
              {"id": "P4", "x": X0, "y": Y1}
            ]
          }
        }
      ]
    }
    The capitalized tokens above describe values, not literal JSON to emit.
    image.width and image.height are positive integers measured from source.
    If no eligible artwork exists, emit crops: [] only after visual review.
31. Machine validity does not prove visual correctness. Keep review status
    separate from structural validation in the runner. Never mark uncertain
    visual results as automatically approved just because the JSON parses.`
