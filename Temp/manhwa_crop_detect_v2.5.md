# manhwa_crop_detect.py — four-point-crop v1.0 detector

Implements the geometry half of the Manhwa Crop Detection Guidelines v2.4:
stitching (ST), container detection (CB), four-side edge resolution (ED),
angled edges (AN), overlay exclusion (OV), whitespace (WS), per-crop
coordinate independence (IX) and the output format (OUT).

The Section Relevance gate (SR) is only PARTIALLY automatable. Everything
that is a measurement is done here; everything that is a judgement about
meaning is routed through `sr_gate()` and flagged `needs_review`, so a
vision model only has to answer a yes/no question about a handful of
already-cropped thumbnails instead of measuring the page.

Dark-background and white-background webtoons are both supported: the page
background level is measured, not assumed. See **Page polarity** below.

Where geometry cannot divide a page at all — a dark full-bleed sequence with
no gutter, frame or seam between its scenes — see **Character-cluster
segmentation (CH)** below. That is a manual/vision fallback, not part of this
script's output, and it applies only inside a container geometry has already
returned whole.

Two further sections cover faults that geometry cannot detect and that raise
no error, so they are only ever caught by looking:

- **Oversized-container audit (OS)** — a single tall crop that actually holds
  several croppable scenes. Every crop is re-checked against it before
  emitting; the technique is to anchor on the subject rather than hunt for a
  boundary that was never drawn.
- **SFX and bubbles never define a crop (SX)** — sound effects and speech
  bubbles surviving past OV and setting crop edges they should have no say
  in.

## Usage

```
python3 manhwa_crop_detect.py page.webp -o crops.json
python3 manhwa_crop_detect.py seg1.jpg seg2.jpg seg3.jpg -o crops.json
python3 manhwa_crop_detect.py page.webp -o crops.json --overlay debug.png
python3 manhwa_crop_detect.py page.webp -o crops.json --thumbs ./review/
python3 manhwa_crop_detect.py white_page.webp -o crops.json --background light

python3 manhwa_crop_detect.py --check crops.json            # validate any document
python3 manhwa_crop_detect.py page.webp --check crops.json  # ...and cross-check dimensions
```

Multiple inputs are treated as ONE continuous stitched page (ST-01..ST-10).

---

# Output contract

**Read this before emitting JSON.** Two rules. Both of them have broken real
output, and neither is caught by "does it parse".

## 1. Every coordinate is a JSON number. Never a string.

```json
{ "id": "P1", "x": 0.0, "y": 0.018066406 }
```

**not**

```json
{ "id": "P1", "x": "0.0", "y": "0.018066406" }
```

The consumer's check is strict:

```js
typeof pt?.x === 'number' && !Number.isNaN(pt.x)
```

`typeof "0.018066406"` is `"string"`, so the point is rejected **before**
anything tries to parse it. A perfectly valid float inside quotes is still a
hard failure. There is no coercion, no fallback, no partial credit.

Exactly seven fields in the whole document are strings:

| string | number |
| --- | --- |
| `format`, `version`, `coordinateSystem` | `image.width`, `image.height` |
| `image.filename` | every `points[].x` |
| `crops[].id`, `crops[].reason`, `crop.mode` | every `points[].y` |

**Why this keeps happening.** `ratio()` returns the decimal *text* of a
number, because the emitter has to control the digits exactly and
`json.dumps` would renormalise them. Text is one keystroke from a string
field, and anything reproducing the emitter's shape tends to add the quotes
back. Three defences now exist:

- `ratio()` documents that it returns bare number text and validates its own
  output against `^(?:0|1|0\.\d+|1\.0)$`.
- the interpolation sites are `"x": {px}` with a `# NO quotes: JSON number`
  comment, and `emit_json()` **raises** if the finished document matches
  `"[xy]"\s*:\s*"`.
- `validate()` type-checks every coordinate with `is_json_number()`, a direct
  mirror of the JS test above.

## 2. Every coordinate is inside 0.0–1.0.

```
x = pixel_x / image.width
y = pixel_y / image.height
```

Both denominators are the numbers emitted in the `image` block — the
**stitched** page, measured after any ST-02 rescale. Never a segment's own
size, never swapped.

A coordinate above 1.0 is always a wrong denominator, never a wide crop. The
reported `crop-01` with `P2/P3 x = 1.625` decodes exactly:

```
1.625 = 1300 / 800
```

an x measured on a 1300px-wide source and divided by the 800px stitched page
width. The three ways to produce it:

| symptom | cause |
| --- | --- |
| x slightly over 1.0 (1.01–1.10) | breakout margin added after normalizing, or an off-by-one on width |
| x over 1.0 by a clean ratio | normalized against a segment's own width, not the stitched page |
| x over 1.0 on rescaled input | normalized against the **pre-resize** width of a segment `stitch()` rescaled (ST-02) |
| x ≈ 3.25 on a tall page, y ≈ 0.3 | x divided by height and y by width — the extents are swapped |

`ratio()` clamps to keep the document schema-valid, and reports what it
clamped rather than hiding it:

```
clamped: crop-01 x1: 1300/800 = 1.625000 is outside 0.0-1.0 and was clamped
         — this crop was measured against the wrong extent, recompute it
```

A clamped crop is a **wrong** crop: the run exits non-zero so it cannot be
mistaken for a clean export. Fix the measurement; do not widen the range.

## Self-check before emitting

1. Does any `x` or `y` have a `"` next to it? → remove it.
2. Is every `x` and `y` between 0.0 and 1.0 inclusive? → if not, you divided
   by the wrong number.
3. Do `image.width`/`image.height` match the page you measured, not one
   segment? → they are the only legal denominators.
4. `P1.x == P4.x`, `P2.x == P3.x`, `P1.y == P2.y`, `P3.y == P4.y`? → the
   rectangle is axis-aligned (H).
5. `P2.x > P1.x` and `P4.y > P1.y`? → non-zero extent.

Those five are about *shape*. Two more are about *content*, and no checker
can run them — a crop can be perfectly shaped and still be the wrong crop:

6. Is any crop oversized (taller than ~2× its width, over ~20% of the page,
   or a big outlier against its neighbours)? → audit it before emitting,
   per **Oversized-container audit (OS)**. This is the detector's most
   common wrong answer and it raises no error.
7. Is any crop edge sitting on a speech bubble or an SFX glyph rather than
   on artwork? → re-resolve it against the art, per **SFX and bubbles never
   define a crop (SX)**.

Or skip the first five and run the checker, which is safe on any input — model
output, hand edits, another tool's export:

```
$ python3 manhwa_crop_detect.py --check model_output.json
checking model_output.json against page 800x2600 (self-reported)

8 VALIDATION PROBLEM(S):
  H: crop-01 P1.x is string ('0.0'), must be a number — drop the quotes, coordinates are JSON numbers
  H: crop-01 P2.x is string ('1.625'), must be a number — drop the quotes, coordinates are JSON numbers
  ...
```

With the quotes removed it reports the second fault, which the type error was
masking:

```
  H: crop-01 P2.x = 1.625 is outside 0.0-1.0 — normalized against something
     other than image.width (a single segment, a pre-resize size, or x
     divided by the other extent)
```

`validate()` previously raised `TypeError: '<=' not supported between
instances of 'float' and 'str'` on a stringified document — it crashed on the
very error it existed to catch, which is why this recurred. It is now
type-safe on malformed, truncated and hand-written input, and every field is
type-checked before it is compared.

## Reference: the consumer-side check

Drop-in, matching the rules above:

```js
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const inUnit = (v) => isNum(v) && v >= 0 && v <= 1;

function checkCrop(crop) {
  const pts = crop?.crop?.points;
  if (!Array.isArray(pts) || pts.length !== 4) return 'points must be 4 objects';
  if (pts.map(p => p?.id).join() !== 'P1,P2,P3,P4') return 'point order wrong';
  for (const p of pts) {
    if (!isNum(p?.x) || !isNum(p?.y)) return `${p?.id}: coordinates must be numbers`;
    if (!inUnit(p.x) || !inUnit(p.y)) return `${p?.id}: outside 0.0-1.0`;
  }
  const [P1, P2, P3, P4] = pts;
  if (P1.x !== P4.x || P2.x !== P3.x) return 'left/right edges not vertical';
  if (P1.y !== P2.y || P3.y !== P4.y) return 'top/bottom edges not horizontal';
  if (P2.x <= P1.x || P4.y <= P1.y) return 'zero or negative extent';
  return null;
}
```

---

## Page polarity

The original pipeline rested on one line — `ink = max(RGB) > 10`, i.e. *the
page is black, anything brighter is artwork*. On a white page that makes
every pixel ink, so the whole page comes back as one container, bubbles
merge into the gutter instead of standing out from it, and glyph detection
hunts for white letters that are actually black.

Three changes fix that, and none of them are "if white: do something else".

**1. Measure the background instead of assuming it.** `measure_background()`
tries three sources in order of trust: the median of *flat rows* (a webtoon
gutter is a full-width band of near-uniform, unsaturated pixels), then the
page border band, then the dominant unsaturated level of the whole page.
Every mask is then expressed as a distance from that level, so black (`6`),
white (`250`), cream (`249,246,238`) and even mid-grey (`128`) pages all work.
The measured level also selects the tuning profile.

This depends on one fix in the saturation maths: `(max-min)/max` is
meaningless near black — a `#040406` gutter scores 0.33 saturation and reads
as a *colour*, which alone was enough to break background detection on a
dark page. Saturation is now pinned to zero wherever hue cannot be judged.

**2. Separate "the colour of the page" from "the page".** On a dark page
these are the same thing, so colour alone is safe. On a white page they are
not: the gutter, the inside of every speech bubble and the sky in a bright
panel are all the same white. What separates them is connectivity — the real
page is the white that *reaches the edge of the image*. `resolve_background()`
floods inward from the border (`bg_mode="connected"`), and anything the flood
cannot reach is content. `frame_seal` closes hairline gaps in drawn frames
first, so a 2px break in a panel border does not let the page leak in.

**3. Make the ink masks polarity-symmetric.**

| mask | dark page | white page |
| --- | --- | --- |
| `page_bg` | the black gutter | white reachable from the border |
| `paper` | bubble fill | bubble fill (interiors only, via `~page_bg`) |
| `strokes` | *empty by construction* | black text and line work |
| `letters` | dark lettering | dark lettering |

`strokes` is `luma < bg_level - stroke_delta`. On a dark page that threshold
falls below zero, so the mask is empty and glyph detection reduces to the
original paper-only behaviour with no branch and no separate code path.

### Profile

Only these differ for a light page (`Config.LIGHT_PROFILE`). Everything else
is already relative to `bg_level` and carries over unchanged.

| tunable | dark | light | why |
| --- | --- | --- | --- |
| `gutter_tol` | 10 | 18 | off-white paper plus webp/jpeg ringing |
| `gutter_sat_max` | 0.10 | 0.08 | |
| `bg_mode` | `color` | `connected` | colour cannot separate bubble from page |
| `frame_seal` | 0 | 3 | keep drawn panel frames closed |
| `bridge_erosion` | 2 | 1 | a 2px erosion eats a thin black frame |
| `sat_floor` | 0.10 | 0.06 | pastel art on white is barely saturated |
| `bubble_max_area` | 0 (off) | 250 000 | a pale panel is not a bubble |
| `bubble_text_min` | 0.0 (off) | 0.015 | a bubble carries lettering; sky does not |

### Two fixes that also apply to dark pages

- **Hollow shapes are measured hollow.** A drawn frame and a panel with a
  bubble cut out of it both score the area of an outline, not a panel, and
  fell under `min_panel_area`. `fill_panel_holes` fills before measuring.
- **A frame is not a text block.** `glyph_max_area` alone let one side of a
  thin frame pass as text; the block test then saw bare page inside the frame
  and deleted it, taking the panel with it. `glyph_max_span` requires a glyph
  to be small in *both* axes. On the dark test page this recovers a panel the
  original silently dropped.

`sr_gate` also no longer discards a large monochrome section outright — a
greyscale flashback is common on white backgrounds and reads as
"text/branding" by colour alone, so anything over `mono_keep_area` is kept
and flagged `review:large_monochrome_section` instead.

## Verified

- **Output contract.** Emitted coordinates parse as JSON numbers (`float`,
  not `str`); `emit_json()` raises on a quoted coordinate; a container
  overrunning the page is clamped to `1.0` and reported with the arithmetic
  that produced it. `validate()` returns problems, and does not raise, for:
  the exact reported document (strings *and* 1.625), strings alone, 1.625
  with correct types, `null`, `true`, `NaN`, zero extent, non-object crops,
  `points` of wrong length or type, a missing `image` block, a stringified
  `image.width`, `{}`, `[]`, `""` and truncated JSON.
- **Polarity.** Synthetic dark and white pages, identical layout (full-bleed
  panel, inset framed panel, bubbles on artwork and on bare page, watermark
  row, pale low-detail panel, tall inset panel): both return the same four
  crops, with bubbles and watermark correctly excluded from anchoring.
- On a `#000000` page the new content mask is bit-identical to the original
  `max(RGB) > gutter_level`, so existing dark tuning is unchanged.
- Edge cases: mid-grey page, full-bleed page with no gutter anywhere, flat
  blank page (0 crops, runaway flood caught and reported), cream paper,
  mixed-width stitching, `--check` with and without images, missing
  `--check` file, missing `images`, missing `-o`, and each override.

## Known limits

- A **borderless pale panel on a white page** is unresolvable by geometry —
  nothing distinguishes its interior from the gutter. A drawn frame makes it
  work; without one, tighten `--gutter-tol`.
- **Full-bleed white pages** have no border for the flood to start from.
  `resolve_background()` reports `no page background reaches the image border`
  and returns an empty background, which yields one page-sized container.
- The runaway guard (`bg_runaway_frac`) falls back to `bg_mode=color` if the
  flood swallows the page, and says so in the output.
- `bg_mode=connected` usually helps dark pages too (enclosed shadow inside a
  panel stops punching a hole in it). It is off by default there only to
  leave existing dark tuning bit-identical — worth trying with
  `--bg-mode connected`.
- Clamping keeps a bad crop *shaped* legally; it does not make it correct.
  Always read the `clamped:` lines and the non-zero exit.
- A **dark full-bleed sequence** — several scenes running edge to edge with
  no gutter, frame or luma seam between them — is likewise unresolvable by
  geometry, and `find_containers` returns it as one tall container. That is
  the correct answer to the question geometry asks. Dividing it needs a
  different signal: see **Character-cluster segmentation (CH)** below.
- **Any oversized crop**, on any polarity, may hold several croppable scenes
  with no boundary between them that geometry can see. This is the most
  common wrong output of the detector and it raises no error, so it is caught
  only by the deliberate re-check in **Oversized-container audit (OS)**.
- **Bubbles and SFX at the crop-bounds stage.** OV keeps them out of the
  content mask, but they still reach the emitted edges — see **SFX and
  bubbles never define a crop (SX)**.
- **Overlays that bridge containers** defeat container assembly on any
  polarity. Speech bubbles crossing a panel boundary fail the `bubble_*`
  tests (they sit on artwork, so `bubble_ring_gutter` is low, and a
  multi-bubble blob's `_blob_fill` is low too), stay in the content mask and
  weld the panels either side into one component. The symptom is a handful of
  enormous containers and near-zero overlay coverage; measure
  `overlay.mean()` and the largest `fill` components before tuning anything
  else.

## Oversized-container audit (OS)

The most common wrong answer this detector gives is not a missing crop or a
misplaced edge. It is **one crop that should have been three** — a tall
pointer, hundreds to thousands of pixels high, that quietly contains several
perfectly croppable scenes inside it.

It happens because geometry only ever answers the question it was asked.
`find_containers` looks for gutters, frames and luma seams; where the artist
drew none, it finds none and returns the whole run as a single container.
That is a correct measurement and a wrong crop. The scenes are separated by
*subject matter*, and subject matter is not a geometric signal.

The failure is quiet, which is what makes it dangerous. An oversized crop is
legally shaped, passes every check in **Self-check before emitting**, sits
inside 0.0–1.0, and reports no error at all. Nothing downstream will catch
it. It has to be caught here, by deliberately re-opening crops that geometry
already called done.

### OS-01 — Always run the audit

After containers are resolved and before crops are emitted, **every** crop is
re-examined against the oversize tests below. This is not conditional on page
polarity, on the container being full-bleed, or on the absence of internal
edges. A tall crop on a white page with a drawn frame around it is just as
capable of holding three scenes as a dark full-bleed one.

Do not skip a crop because geometry sounded confident about it. Geometry is
always confident; that is the problem.

### OS-02 — What counts as oversized

Flag a crop for audit if **any** of these hold. These are triggers for a
second look, not verdicts — a flagged crop is often correct, and the audit is
what establishes that.

- **Aspect.** Height exceeds ~2× its own width. A single manhwa panel is
  rarely taller than it is wide by more than that; a run of scenes almost
  always is.
- **Page share.** It occupies more than ~20% of total page height on its own.
- **Relative outlier.** It is more than ~2.5× the median height of the other
  crops on the same page. A page of eight 600 px panels and one 4800 px panel
  is telling you something about the 4800 px one.
- **Subject count.** It visibly contains two or more separated character
  groups, regardless of its measured size. This one overrides the numbers in
  both directions: a modest 1.2× crop holding two clearly distinct scenes is
  oversized, and a 6× tall crop holding one continuous falling figure is not.

### OS-03 — Anchor on the subject, not on the gap

This is the core technique, and it inverts the usual approach. Do not hunt
for the boundary between scenes — on these pages there is nothing there to
find, which is precisely why geometry failed. **Find the subjects first, then
derive the boundaries from them.**

Work in this order:

1. **Locate every anchor.** An anchor is a character, a face, a hand, a
   distinct object or a focal point of action — the thing a reader's eye
   lands on. Sweep the full height of the crop and mark each one's vertical
   extent. On dark pages the hue masks in **The character mask** below do
   this mechanically; on lighter or busier pages, read it visually.
2. **Group anchors into scenes.** Anchors close together, at a consistent
   scale, sharing a background, belong to one scene. A jump in scale
   (close-up → wide shot), a change in background colour or lighting, or a
   change in the cast present marks a new one.
3. **Derive each boundary from the gap between two groups**, placing it at
   the centre of the empty span rather than hard against either subject
   (see CH-06).
4. **Verify each resulting crop stands alone.** Each one should be
   independently readable as a moment: it has a subject, that subject is
   whole, and nothing of the next scene intrudes. If a candidate crop has no
   subject at all, the split was wrong — go back to step 2 and regroup, do
   not keep the empty crop.

A crop with no anchor in it is almost always a mistake. That is the single
most useful test in this section: **every crop should be about something.**

### OS-04 — Boundaries that are not boundaries

Several things look like scene breaks and are not. Splitting on any of them
cuts a scene in half.

- **SFX glyphs.** Large stylised sound effects routinely sit *between* two
  moments of the same scene, or bleed across a real boundary. They mark
  emphasis, not structure. See **SFX and bubbles never define a crop (SX)**.
- **Speech bubbles and narration boxes.** Same reasoning, and they span
  scenes deliberately — carrying dialogue over a cut is exactly what they are
  for.
- **A patch of empty shadow or sky.** Empty space inside a single wide
  establishing shot is part of the shot. Absence of characters is necessary
  for a boundary, never sufficient for one (CH-09).
- **A speed-line or motion-blur field.** It belongs to the action that
  produced it, and it continues through the very gap that looks splittable.

### OS-05 — When not to split

Leave the crop whole, and say why, when:

- It holds **one continuous subject** at full height — a falling figure, a
  tall mecha, a vertical panorama, a single sprawling action beat.
- The scenes inside it are **genuinely inseparable**: they overlap, or one
  character's artwork crosses the only candidate boundary.
- It contains **no detectable anchors at all** — pure landscape, effects or
  abstract shadow. Flag `review:no_characters_present` (CH-12) and move on.

Over-splitting is a real failure too. Two crops of half a character each are
worse than one correct tall crop.

### OS-06 — Report every audit

Record the outcome for each audited crop, including the ones left whole. A
reader must be able to tell *"this stayed one crop because it was checked and
found continuous"* from *"this stayed one crop because nobody looked"*. Note
the trigger that flagged it (OS-02), the anchors found, and the decision.

## SFX and bubbles never define a crop (SX)

Overlay exclusion (OV) already removes bubbles and lettering from the
**content mask**, so they cannot weld two panels together or seed a container
of their own. That is a detection-stage fix and it is not sufficient — these
elements keep reappearing at the **crop-bounds** stage, where they stretch a
crop outward or anchor an edge that should have sat elsewhere.

The rule is the same wherever it is applied: **an SFX glyph, speech bubble or
narration box is never what a crop is about, and never what sets its edge.**

- **SX-01** No crop edge may be positioned by a bubble, narration box or SFX
  stroke. Resolve every edge against artwork — panel border, gutter, or the
  extent of the subject. If removing the overlay would move the edge, the
  edge was wrong.
- **SX-02** An overlay that extends past its panel does not extend the crop.
  A bubble with its tail hanging into the gutter, or an SFX glyph running off
  the panel edge, is clipped at the artwork boundary. The crop follows the
  art.
- **SX-03** An overlay bridging two panels belongs to neither crop's bounds.
  Cut both crops at their own artwork edges and let the overlay be split
  between them. Do not grow either crop to contain it whole.
- **SX-04** A region of pure SFX is not a crop. Merge it into the neighbour
  whose artwork actually continues through it, decided by looking (CH-11).
  A lone SFX crop is always an error.
- **SX-05** Bubble-dense pages need the check run explicitly. Where dialogue
  covers much of the page, the artwork under the bubbles is still the
  subject. Measure the crop against what is *drawn*, not against what is
  *printed on top of it*.

The practical test, for any edge and any crop: **mentally delete every bubble
and every SFX glyph, and ask whether the crop still makes sense.** If it
collapses, or if an edge moves, the overlay was doing work it should never
have been doing.

## Character-cluster segmentation (CH)

Geometry finds *containers*. On a dark full-bleed sequence there are no
containers: no gutter, no frame, no luma seam, nothing to find. The page is
one continuous wash of shadow that reads as several distinct scenes, and
`find_containers` correctly returns it as **one** — correctly, because by the
rules above it *is* one. The scenes are separated by subject matter, not by
geometry, so they have to be found by asking a different question: **where are
the characters?**

This is the rule set for that case. It is a *fallback*, not a replacement:
geometry first, and CH only in the region geometry could not divide.

CH is the **mechanical instance** of the anchoring technique described in
OS-03. The audit in **Oversized-container audit (OS)** is the general rule and
applies to every oversized crop on every kind of page; CH is what that rule
becomes when the page is dark enough that the anchors can be found by hue
rather than by eye. Where CH's gate below does not admit a region, the OS
audit still does — fall back to reading it visually, and use CH-05 through
CH-13 as the method regardless of how the anchors were located.

### When CH applies

All four must hold for the *automated* hue-mask route below. If any fails,
that does not settle the crop — it means the anchors cannot be found
mechanically, so the region goes to the visual audit in OS-03 instead. Only
OS-05 concludes that a region is genuinely one crop.

- **CH-01** The container is full-bleed (spans the page width) and tall —
  taller than roughly 2× the page width.
- **CH-02** Its background is uniformly dark, and no white gutter band,
  drawn frame or flat luma seam appears anywhere inside it. Verify, do not
  assume: scan for full-width uniform rows first (see ST/CB) and confirm the
  count is zero.
- **CH-03** It contains two or more visually separate scenes. A single scene
  that merely *contains* several characters is one crop.
- **CH-04** Characters are detectable. A region of pure effects, landscape or
  abstract shadow has nothing to cluster on — leave it whole and flag it.

### The character mask

Characters are found by hue, because on a dark page they are the only warm,
saturated things present. Three masks, OR'd together:

| mask | test | catches |
| --- | --- | --- |
| skin | `R>150 & G>110 & B>90 & R>B+25` | faces, hands |
| red hair | `R>110 & R>G+55 & R>B+45` | red/orange hair |
| blond hair | `R>170 & G>150 & B<150 & R>B+45` | blond/yellow hair |

Thresholds are a starting point, not a constant: they are tuned for the
dark-background case where the surrounding art is blue-black. On a warmer
page raise the `R>B` margins until background stops registering. Always
profile the mask down the region and *look at the numbers* before trusting a
split — a mask that fires everywhere is not detecting characters.

White or silver hair is deliberately **not** in the mask. It is
indistinguishable from pale sky, highlight, energy effects and SFX strokes,
and adding it produces splits in the middle of empty shadow. Faces and hands
carry those characters instead.

### Finding the splits

- **CH-05** Profile the character mask per row down the region, then bin
  (100 px bins work well for a ~5000 px region). What you are looking for is
  **clusters separated by troughs where character coverage reaches zero** —
  not local minima, actual zero.
- **CH-06** Place each split at the **centre of its trough**, not at the
  first or last row of it. The trough is the empty space between two scenes
  and it belongs to neither; splitting at its edge crops one scene tight
  against its subject and gives the other all the slack.
- **CH-07** Re-scan each candidate boundary at fine resolution (25 px bins)
  before committing. A trough that looks clean at 100 px can turn out to hold
  a stray hand or a distant face.
- **CH-08** A trough must be substantial — as a rule of thumb, at least
  ~150 px on a page of this scale. Two clusters separated by a 30 px dip are
  one scene with a gap in it, not two scenes.
- **CH-09** Corroborate every split with a second signal before accepting it:
  mean luma, background colour, or a visual read of the boundary. Character
  absence alone is necessary, not sufficient — it cannot tell a scene change
  from a character simply walking out of frame. Where the two signals
  disagree, prefer the one you can see.

### SFX and speech are never boundaries

- **CH-10** Speech bubbles, narration boxes and SFX glyphs are **ignored
  entirely** for segmentation. They routinely span two scenes — that is what
  they are for — and a split placed on one cuts a scene in half.
- **CH-11** A stretch containing only SFX is **not a section**. Measure it:
  if the SFX strokes are a small fraction of the region and the rest is
  continuous artwork belonging to a neighbouring scene, it is part of that
  neighbour. Merge it *upward or downward according to which scene's artwork
  actually continues through it* — decided by looking, not by defaulting to
  one direction.
- **CH-12** Only after the merge in CH-11, if a region genuinely has no
  characters and no continuing artwork, keep it and flag
  `review:no_characters_present`. This is the last resort, not the first
  response to a character-free stretch.

### Worked example

An 800×14145 dark-fantasy page. Geometry gave 8 containers; the last was
4819 px tall (34% of the page), full-bleed, with no internal separation of
any kind — CH-01 and CH-02 both satisfied.

The character profile found four clusters with zero-coverage troughs between
them:

| cluster (y) | trough before | split at |
| --- | --- | --- |
| 9826–10190 | — (region start) | 9326 |
| 10560–11190 | 10200–10550 | 10380 |
| 11350–11945 | 11200–11340 | 11270 |
| 12900–13500 | 12750–12890 | 12895 |

A fifth stretch, y 11950–12890, held crossed-blade SFX and no characters at
all. Under CH-12 alone it would have become its own crop. Measuring it
instead (CH-11) settled it: **2.05%** of its pixels were SFX strokes and
**62%** were continuous dark shadow belonging to the reaction scene above
it — so it merged *upward* into that scene rather than becoming a section or
merging down into the final shot.

The last boundary was corroborated per CH-09: luma bottoms out at ~22 across
y 12750–12825, then climbs 71 → 104 → 128 from y 12900 as the pale sky of the
final scene begins. Character absence and luma agreed, so the split stands at
12895.

Result: 4 crops in place of 1, every one a coherent scene, and no crop
anchored on an SFX stroke.

### Reporting

- **CH-13** A CH-derived crop is a *judgement*, not a measurement. Record in
  the metadata that it came from character clustering, name the cluster and
  trough rows it was derived from, and say which splits were corroborated and
  how. A reader must be able to tell a CH boundary from a gutter boundary
  without re-deriving it.


## Source

```python
#!/usr/bin/env python3
"""
manhwa_crop_detect.py — four-point-crop v1.0 detector

Implements the geometry half of the Manhwa Crop Detection Guidelines v2.4:
stitching (ST), container detection (CB), four-side edge resolution (ED),
angled edges (AN), overlay exclusion (OV), whitespace (WS), per-crop
coordinate independence (IX) and the output format (OUT).

The Section Relevance gate (SR) is only PARTIALLY automatable. Everything
that is a measurement is done here; everything that is a judgement about
meaning is routed through `sr_gate()` and flagged `needs_review`, so a
vision model only has to answer a yes/no question about a handful of
already-cropped thumbnails instead of measuring the page.

Page polarity
-------------
The detector measures the page background level instead of assuming it is
black, so dark-background and white-background webtoons both work. The
background level picks a tuning profile (`Config.profile`) and every mask
is expressed relative to that level rather than to an absolute "dark"
threshold. `--background` pins the profile when auto-detection guesses
wrong; `--bg-level`, `--gutter-tol` and `--bg-mode` override the measured
numbers directly.

Output contract
---------------
Every coordinate is an unquoted JSON number inside 0.0-1.0. The consumer
tests `typeof pt?.x === 'number'`, so "0.018066406" fails as a string no
matter how well it parses; x divides by image.width and y by image.height,
both from the stitched page, so a value above 1.0 means the wrong extent was
used. `ratio()` guarantees both, `emit_json()` asserts no coordinate came
out quoted, and `validate()` reports either fault instead of raising.

Usage
-----
    python3 manhwa_crop_detect.py page.webp -o crops.json
    python3 manhwa_crop_detect.py seg1.jpg seg2.jpg seg3.jpg -o crops.json
    python3 manhwa_crop_detect.py page.webp -o crops.json --overlay debug.png
    python3 manhwa_crop_detect.py page.webp -o crops.json --thumbs ./review/
    python3 manhwa_crop_detect.py white_page.webp -o crops.json --background light
    python3 manhwa_crop_detect.py --check crops.json          # validate anything

Multiple inputs are treated as ONE continuous stitched page (ST-01..ST-10).
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, fields, replace
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


# ───────────────────────────── configuration ─────────────────────────────
@dataclass
class Config:
    """Every tunable in one place.

    `Config()` is the original dark-background tuning. `Config.profile("light")`
    swaps the tunables that genuinely depend on page polarity; `detect()` picks
    the profile from the measured background unless the caller pins one.
    """

    # --- page background measurement --------------------------------------
    bg_level: int | None = None     # page background luma; None => measured
    gutter_tol: int = 10            # |luma - bg_level| <= this is page gutter
    gutter_sat_max: float = 0.10    # the gutter is never a saturated colour
    flat_row_std: float = 4.0       # a gutter row is flat across the full width
    min_flat_rows: int = 24         # need this many before trusting flat rows
    border_band: int = 8            # fallback: px sampled along the page edge

    # --- gutter -> background region --------------------------------------
    bg_mode: str = "color"          # "color" | "connected" (see resolve_background)
    frame_seal: int = 0             # closing radius that seals hairline panel frames
    bg_runaway_frac: float = 0.99   # connected-mode sanity limit before falling back

    # --- ink separation ---------------------------------------------------
    white_level: int = 205          # min(RGB) > this is "paper white" (bubble fill)
    stroke_delta: int = 60          # luma this far BELOW the background is a stroke
    text_dark_level: int = 90       # max(RGB) < this is lettering, either polarity
    sat_floor: float = 0.10         # below this a pixel is greyscale
    colored_value_min: int = 40     # too dark to judge a hue
    chroma_floor: int = 8           # max-min below this is neutral, whatever the ratio says

    # --- what can be a container (SR-01 lower bound) ----------------------
    min_panel_area: int = 40_000    # px
    min_panel_width: int = 60
    min_panel_height: int = 60

    # --- overlay detection (OV) ------------------------------------------
    bubble_min_area: int = 5_000        # solid paper blob big enough to be a bubble
    bubble_max_area: int = 0            # 0 = no cap; guards pale panels on light pages
    bubble_fill_ratio: float = 0.50     # solidity of the blob once its tail is opened away
    bubble_open_radius: int = 8         # opening that removes bubble tails and spikes
    bubble_ring_gutter: float = 0.50    # fraction of surrounding ring that is bare page
    bubble_color_max: float = 0.20      # a real bubble has NO artwork inside it
    bubble_text_min: float = 0.0        # lettering required inside the blob (0 = off)
    bubble_dilate: int = 8              # grow to swallow the bubble's outline
    glyph_max_area: int = 5_000         # ink components this small may be text
    glyph_max_span: int = 110           # ...and small in BOTH axes; 0 disables
    glyph_cluster_gap: int = 40         # dilation that groups glyphs into a text block
    text_block_color_max: float = 0.25  # coloured fraction allowed in a text bbox
    text_block_gutter_min: float = 0.55 # text sits on bare page, not on artwork

    # --- container assembly ----------------------------------------------
    bridge_erosion: int = 2         # severs thin overlay-to-panel contacts
    breakout_margin: int = 4        # NC-05 breathing room so artwork is never clipped
    fill_panel_holes: bool = True   # a hole punched by an overlay is still panel

    # --- SR heuristics ----------------------------------------------------
    line_density_floor: float = 0.012   # below this, likely background-only (SR-05)
    mono_frac_ceiling: float = 0.93     # above this, pure B/W => text/branding
    mono_keep_area: int = 250_000       # ...unless it is far too big to be branding

    # Only these differ for a white/light page. Everything else above is
    # already expressed relative to `bg_level`, so it carries over unchanged.
    LIGHT_PROFILE = {
        "gutter_tol": 18,           # off-white paper + webp/jpeg noise
        "gutter_sat_max": 0.08,
        "bg_mode": "connected",     # colour alone cannot separate bubble from page
        "frame_seal": 3,            # keep drawn panel frames closed
        "bridge_erosion": 1,        # a 2px erosion eats a thin black frame
        "sat_floor": 0.06,          # pastel art on white is barely saturated
        "bubble_max_area": 250_000,
        "bubble_text_min": 0.015,
    }

    @classmethod
    def profile(cls, polarity: str, **overrides) -> "Config":
        cfg = cls()
        if polarity == "light":
            cfg = replace(cfg, **cls.LIGHT_PROFILE)
        known = {f.name for f in fields(cls)}
        bad = set(overrides) - known
        if bad:
            raise ValueError(f"unknown config field(s): {sorted(bad)}")
        return replace(cfg, **{k: v for k, v in overrides.items() if v is not None})


# ───────────────────────────── ST: stitching ─────────────────────────────
def stitch(paths: list[Path]) -> tuple[np.ndarray, list[int]]:
    """ST-01/ST-02/ST-10: combine segments, in order, into one logical page.

    Returns the RGB array and the y offset at which each segment starts, so
    a caller can report which source image a crop began in. The offsets are
    NOT used as crop boundaries (ST-03).
    """
    images = [Image.open(p).convert("RGB") for p in paths]
    width = max(im.width for im in images)
    normalised = []
    for im in images:
        if im.width != width:  # keep the combined page rectangular
            h = round(im.height * width / im.width)
            im = im.resize((width, h), Image.LANCZOS)
        normalised.append(np.asarray(im, dtype=np.uint8))

    offsets, y = [], 0
    for arr in normalised:
        offsets.append(y)
        y += arr.shape[0]

    return np.vstack(normalised), offsets


# ──────────────────── BG: background level and polarity ──────────────────
def channel_stats(rgb: np.ndarray, cfg: Config) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """luma (max channel), min channel, and a saturation that behaves near black.

    Relative saturation, (max-min)/max, is meaningless at the bottom of the
    range: a #040406 gutter scores 0.33 and would be read as a colour, which
    is what stopped the dark page from being recognised at all. Saturation is
    pinned to zero wherever hue cannot be judged — absolute chroma under
    `chroma_floor`, or luma under `colored_value_min` — and that is what lets
    one gutter test serve a black page and a white one. On a #000000 page the
    result is bit-identical to the original `ink = max(RGB) > gutter_level`.
    """
    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    chroma = mx - mn
    with np.errstate(divide="ignore", invalid="ignore"):
        sat = np.where(mx > 0, chroma / np.maximum(mx, 1), 0.0)
    sat = np.where((chroma <= cfg.chroma_floor) | (mx <= cfg.colored_value_min), 0.0, sat)
    return mx, mn, sat


def _mode_median(values: np.ndarray, tol: int) -> int:
    """Dominant level of a 0-255 sample, refined by the median around it."""
    hist = np.bincount(values.astype(np.uint8), minlength=256).astype(np.float32)
    smooth = ndimage.uniform_filter1d(hist, size=5)
    peak = int(np.argmax(smooth))
    near = values[np.abs(values.astype(np.int16) - peak) <= tol]
    return int(round(float(np.median(near)))) if near.size else peak


def measure_background(rgb: np.ndarray, cfg: Config) -> tuple[int, str]:
    """Estimate the page background luma. Works for black, white or grey pages.

    Three sources, in order of trust:

    1. Flat rows. A webtoon gutter is a full-width band of near-uniform,
       unsaturated pixels. If enough rows look like that, their median is the
       background, whatever colour it happens to be.
    2. The page border band. Full-bleed pages have no gutter rows, but the
       outer few px are still almost always page, not subject.
    3. The dominant unsaturated level over the whole page.
    """
    mx, _mn, sat = channel_stats(rgb, cfg)

    flat = (mx.std(axis=1) <= cfg.flat_row_std) & (sat.mean(axis=1) <= cfg.gutter_sat_max)
    if int(flat.sum()) >= cfg.min_flat_rows:
        return int(round(float(np.median(np.median(mx[flat], axis=1))))), "flat_rows"

    k = max(1, cfg.border_band)
    border = np.zeros(mx.shape, bool)
    border[:, :k] = border[:, -k:] = border[:k, :] = border[-k:, :] = True
    band = mx[border & (sat <= cfg.gutter_sat_max)]
    if band.size >= 1_000:
        return _mode_median(band, cfg.gutter_tol), "border_band"

    flatpix = mx[sat <= cfg.gutter_sat_max]
    if flatpix.size >= 1_000:
        return _mode_median(flatpix, cfg.gutter_tol), "page_mode"
    return int(round(float(np.median(mx)))), "page_median"


def polarity_of(bg_level: int) -> str:
    return "light" if bg_level >= 128 else "dark"


# ───────────────────────────── pixel masks ───────────────────────────────
def resolve_background(gutter_color: np.ndarray, cfg: Config) -> tuple[np.ndarray, list[str]]:
    """Turn "pixels the colour of the page" into "pixels that ARE the page".

    On a dark page the two are the same thing: nothing inside a panel is
    #000000-flat, so colour alone is a safe test ("color" mode).

    On a white page it is not. The gutter, the inside of every speech
    bubble and the sky in a bright panel are all the same white, so colour
    puts holes through the artwork and merges bubbles into the gutter.
    What actually separates them is CONNECTIVITY: the real page is the
    white that reaches the edge of the image. Everything the flood cannot
    reach — bubble interiors, framed panel interiors — is content
    ("connected" mode). `frame_seal` closes hairline gaps in drawn frames
    first, so a 2px break in a panel border does not let the page leak in.
    """
    notes: list[str] = []
    if cfg.bg_mode not in ("color", "connected"):
        raise ValueError(f"bg_mode must be 'color' or 'connected', got {cfg.bg_mode!r}")
    if cfg.bg_mode == "color":
        return gutter_color, notes

    floodable = gutter_color
    if cfg.frame_seal:
        r = cfg.frame_seal
        disk = np.ones((2 * r + 1, 2 * r + 1), bool)
        floodable = ~ndimage.binary_closing(~gutter_color, disk, border_value=0)

    seeds = np.zeros_like(floodable)
    seeds[0, :] = seeds[-1, :] = True
    seeds[:, 0] = seeds[:, -1] = True
    seeds &= floodable
    if not seeds.any():  # full-bleed page: no background touches the border
        notes.append("no page background reaches the image border")
        return np.zeros_like(gutter_color), notes

    page_bg = ndimage.binary_propagation(seeds, mask=floodable)
    page_bg |= gutter_color & ndimage.binary_dilation(page_bg)  # give back the sealed rim

    if float(page_bg.mean()) > cfg.bg_runaway_frac:
        notes.append(
            f"flood covered {page_bg.mean():.1%} of the page — fell back to bg_mode=color"
        )
        return gutter_color, notes
    return page_bg, notes


def build_masks(rgb: np.ndarray, cfg: Config) -> dict:
    """All masks are relative to `cfg.bg_level`, which is what makes the same
    code work on a black page and a white one.

    page_bg  the page itself (was: `~ink`)
    content  anything that is not page (was: `ink`)
    paper    near-white fill: bubble and narration bodies, either polarity
    strokes  ink noticeably darker than the page: black text and line work.
             On a dark page the threshold falls below 0, so this is empty and
             glyph detection reduces to the original paper-only behaviour.
    letters  near-black pixels; lettering is dark on both polarities
    """
    if cfg.bg_level is None:
        raise ValueError("cfg.bg_level must be set before build_masks(); see detect()")

    mx, mn, sat = channel_stats(rgb, cfg)
    gutter_color = (np.abs(mx - cfg.bg_level) <= cfg.gutter_tol) & (sat <= cfg.gutter_sat_max)
    page_bg, notes = resolve_background(gutter_color, cfg)

    return {
        "page_bg": page_bg,
        "content": ~page_bg,
        "paper": mn > cfg.white_level,
        "strokes": (mx < cfg.bg_level - cfg.stroke_delta) & (sat <= cfg.sat_floor),
        "letters": mx < cfg.text_dark_level,
        "colored": (sat > cfg.sat_floor) & (mx > cfg.colored_value_min),
        "luma": mx,
        "notes": notes,
    }


def line_density(luma: np.ndarray, box: tuple[int, int, int, int]) -> float:
    """Fraction of pixels sitting on a strong edge — a proxy for line art.

    Flat sky, gradients and bokeh score near zero; drawn characters and
    panel detail score high. Used only as an SR-05 *hint*, never a verdict.
    Polarity-free: a Sobel magnitude does not care which side is brighter.
    """
    y0, y1, x0, x1 = box
    patch = luma[y0:y1, x0:x1].astype(np.float32)
    if patch.size < 400:
        return 0.0
    gy = ndimage.sobel(patch, axis=0)
    gx = ndimage.sobel(patch, axis=1)
    mag = np.hypot(gx, gy)
    return float((mag > 120).mean())


# ───────────────────────────── OV: overlays ──────────────────────────────
def _blob_fill(comp: np.ndarray, radius: int) -> float:
    """Solidity of a component after its tails are opened away.

    A speech bubble is a solid blob with a thin pointer tail. Measuring fill
    over the raw bounding box lets the tail halve the score and the bubble
    escapes detection, so open the shape first and measure only the body.
    """
    disk = np.ones((2 * radius + 1, 2 * radius + 1), bool)
    opened = ndimage.binary_opening(comp, disk)
    if opened.sum() < 500:
        return 0.0
    rows = np.nonzero(opened.any(axis=1))[0]
    cols = np.nonzero(opened.any(axis=0))[0]
    bbox = (rows[-1] - rows[0] + 1) * (cols[-1] - cols[0] + 1)
    return float(opened.sum()) / max(bbox, 1)


def _ring_gutter(page_bg: np.ndarray, box, pad: int = 14) -> float:
    """Fraction of the band just outside `box` that is bare page."""
    y0, y1, x0, x1 = box
    H, W = page_bg.shape
    oy0, oy1 = max(0, y0 - pad), min(H, y1 + pad)
    ox0, ox1 = max(0, x0 - pad), min(W, x1 + pad)
    outer = page_bg[oy0:oy1, ox0:ox1]
    total = outer.size - (y1 - y0) * (x1 - x0)
    if total <= 0:
        return 0.0
    bare = outer.sum() - page_bg[y0:y1, x0:x1].sum()
    return float(bare) / total


def _text_inside(letters: np.ndarray, comp: np.ndarray, box) -> float:
    """Lettering as a fraction of the blob's filled body.

    The letters are holes in the white blob, so fill the component before
    measuring. A bubble carries text; a pale patch of sky does not. This is
    the test that stops a white-page panel interior from being eaten as a
    bubble, and it reads the same on either polarity because lettering is
    dark either way.
    """
    y0, y1, x0, x1 = box
    body = ndimage.binary_fill_holes(comp)
    if body.sum() == 0:
        return 0.0
    return float(letters[y0:y1, x0:x1][body].mean())


def detect_overlays(masks: dict, cfg: Config) -> np.ndarray:
    """OV-01..OV-09: speech bubbles, narration boxes, watermark text.

    Overlays are removed from the page BEFORE containers are assembled, so
    they can never anchor or enlarge a crop.
    """
    page_bg, paper = masks["page_bg"], masks["paper"]
    strokes, letters, colored = masks["strokes"], masks["letters"], masks["colored"]
    overlay = np.zeros_like(page_bg)

    # Candidates are paper that is NOT the page, plus (light pages only)
    # strokes: dark lettering on a white page. `~page_bg` is what keeps a
    # white gutter out of the bubble hunt — without it, every bubble on a
    # white page is one component with the whole page.
    fill = (paper | strokes) & ~page_bg
    lbl, n = ndimage.label(fill)
    if n == 0:
        return overlay

    objects = ndimage.find_objects(lbl)
    areas = ndimage.sum_labels(fill, lbl, index=np.arange(1, n + 1))
    glyphs = np.zeros_like(page_bg)

    for i, sl in enumerate(objects, start=1):
        if sl is None:
            continue
        area = float(areas[i - 1])
        ys, xs = sl
        box = (ys.start, ys.stop, xs.start, xs.stop)
        comp = lbl[sl] == i

        # --- speech / narration bubble: a solid blob floating in the gutter
        # with nothing drawn inside it. The interior test is what separates a
        # bubble from a pale panel background (both are big, white and solid);
        # on a white page the area cap and the lettering test do the rest.
        if (
            area >= cfg.bubble_min_area
            and (cfg.bubble_max_area <= 0 or area <= cfg.bubble_max_area)
            and colored[ys, xs][comp].mean() <= cfg.bubble_color_max
            and _ring_gutter(page_bg, box) >= cfg.bubble_ring_gutter
            and _blob_fill(comp, cfg.bubble_open_radius) >= cfg.bubble_fill_ratio
            and _text_inside(letters, comp, box) >= cfg.bubble_text_min
        ):
            overlay[sl] |= comp
            continue

        # --- candidate text glyph (narration line, watermark, credit)
        # Area alone is not enough. A hollow panel frame is thin, so a whole
        # side of it weighs less than 5k px and used to be filed as text —
        # then the block test passed (bare page inside the frame, no colour)
        # and the frame was deleted, taking the panel with it. A letter is
        # small in BOTH axes; a frame or a divider rule is not.
        span = max(ys.stop - ys.start, xs.stop - xs.start)
        if area <= cfg.glyph_max_area and (cfg.glyph_max_span <= 0 or span <= cfg.glyph_max_span):
            glyphs[sl] |= comp

    # Group glyphs into text blocks. A block only counts as narration or
    # branding if it sits on BARE PAGE — mostly gutter between the letters,
    # and no artwork under it. Without the gutter test, the pale background
    # of a bright panel fragments into thousands of "glyphs" and the panel
    # eats itself.
    if glyphs.any():
        grouped = ndimage.binary_dilation(
            glyphs, structure=np.ones((3, cfg.glyph_cluster_gap), bool)
        )
        gl, _ = ndimage.label(grouped)
        for sl in ndimage.find_objects(gl):
            if sl is None:
                continue
            ys, xs = sl
            on_bare_page = page_bg[ys, xs].mean() >= cfg.text_block_gutter_min
            no_artwork = colored[ys, xs].mean() <= cfg.text_block_color_max
            if on_bare_page and no_artwork:
                overlay[ys, xs] |= glyphs[ys, xs]

    # Grow overlays to swallow their own outlines and drop shadows.
    if overlay.any():
        overlay = ndimage.binary_dilation(
            overlay, ndimage.generate_binary_structure(2, 2), iterations=cfg.bubble_dilate
        )
    return overlay


# ────────────────────── CB / ED / AN: containers ─────────────────────────
@dataclass
class Container:
    y0: int
    y1: int
    x0: int
    x1: int
    area: int
    line_density: float
    colored_frac: float
    mono_frac: float


def find_containers(masks: dict, overlay: np.ndarray, cfg: Config) -> list[Container]:
    """CB-01/CB-07 + ED-01..ED-08 + AN-01..AN-07.

    Each connected run of artwork is one container. Taking the axis-aligned
    bounding box of that component satisfies AN-02 (crop stays rectangular)
    and AN-03 (the outer extent of an angled edge is, by definition, the
    bbox edge) without any special-casing. Because every component is
    measured on its own, IX-01..IX-07 hold for free: no crop can inherit a
    neighbour's left or right edge.
    """
    content, colored, luma = masks["content"], masks["colored"], masks["luma"]
    body = content & ~overlay

    # A removed bubble leaves a hole, and a drawn frame is hollow to begin
    # with. Both are still panel: fill them before measuring, or a framed
    # white-page panel scores the area of its own outline and is discarded.
    if cfg.fill_panel_holes:
        body = ndimage.binary_fill_holes(body)

    # Sever any remaining hair-thin bridges between adjacent artwork.
    if cfg.bridge_erosion:
        core = ndimage.binary_erosion(body, iterations=cfg.bridge_erosion)
    else:
        core = body

    lbl, n = ndimage.label(core, structure=ndimage.generate_binary_structure(2, 2))
    out: list[Container] = []
    H, W = content.shape

    for sl in ndimage.find_objects(lbl):
        if sl is None:
            continue
        ys, xs = sl
        # give back what erosion took (ED-02..ED-05), plus NC-05 breathing room
        pad = cfg.bridge_erosion + cfg.breakout_margin
        y0, y1 = max(0, ys.start - pad), min(H, ys.stop + pad)
        x0, x1 = max(0, xs.start - pad), min(W, xs.stop + pad)

        h, w = y1 - y0, x1 - x0
        if h < cfg.min_panel_height or w < cfg.min_panel_width:
            continue

        region = body[y0:y1, x0:x1]
        area = int(region.sum())
        if area < cfg.min_panel_area:
            continue

        box = (y0, y1, x0, x1)
        sub = content[y0:y1, x0:x1]
        lit = max(int(sub.sum()), 1)
        col = float(colored[y0:y1, x0:x1].sum()) / lit

        out.append(
            Container(
                y0=y0,
                y1=y1,
                x0=x0,
                x1=x1,
                area=area,
                line_density=line_density(luma, box),
                colored_frac=col,
                mono_frac=1.0 - col,
            )
        )

    out.sort(key=lambda c: c.y0)  # OUT-07
    return out


# ───────────────────────────── SR: relevance ─────────────────────────────
def sr_gate(c: Container, cfg: Config) -> tuple[bool, str]:
    """Stage 1 gate. Returns (keep, verdict).

    Automatable rules are enforced. SR-05 (background-only) is genuinely a
    judgement call — flat sky and a moody establishing shot are pixel-wise
    similar — so low-detail sections are kept but marked `review`, and the
    caller is expected to confirm them with a vision model.
    """
    if c.mono_frac >= cfg.mono_frac_ceiling:
        if c.area >= cfg.mono_keep_area:
            # Greyscale flashbacks and pen-and-ink pages are common on white
            # backgrounds and read as "monochrome"; too big to silently drop.
            return True, "review:large_monochrome_section"
        return False, "skip:text_or_branding"  # SR-04 / SR-06
    if c.line_density < cfg.line_density_floor:
        return True, "review:possible_background_only"  # SR-05
    return True, "keep"


def describe(c: Container, page_w: int) -> str:
    """OUT-09: short factual snake_case label. Refine with a model if wanted."""
    full = c.x0 <= 2 and c.x1 >= page_w - 2
    tall = (c.y1 - c.y0) > 1.4 * (c.x1 - c.x0)
    width_word = "full_width" if full else "inset"
    shape_word = "tall" if tall else "wide"
    return f"{width_word}_{shape_word}_scene"


# ───────────────────────────── OUT: emission ─────────────────────────────
# Coordinates are JSON NUMBERS. The downstream validator tests
#     typeof pt?.x === 'number' && !Number.isNaN(pt.x)
# so `"x": "0.018066406"` fails before anything tries to parse it, however
# valid the numeral is. `ratio()` returns the decimal TEXT of a number and
# the caller interpolates it WITHOUT quotes; the only strings in the whole
# document are format, version, filename, coordinateSystem, id, reason and
# mode. `emit_json()` asserts this on the way out.
_BARE_NUMBER = re.compile(r"^(?:0|1|0\.\d+|1\.0)$")
_QUOTED_COORD = re.compile(r'"[xy]"\s*:\s*(?:"|null|true|false)')


def ratio(value: int, extent: int, warnings: list[str] | None = None, label: str = "") -> str:
    """OUT-01/OUT-10/OUT-11: exact normalized ratio, <=9dp, 0.0 / 1.0 form.

    Returns bare decimal text for a JSON number — never quoted, never in
    exponent form, always inside 0.0-1.0.

    A value outside the range means the crop was normalized against the
    wrong extent, not that the emitter needs a wider range: the usual causes
    are dividing x by a single segment's width instead of the stitched page
    width, using the pre-resize width of a rescaled segment (ST-02), or
    swapping width and height. The value is clamped so the document stays
    schema-valid, and the miscalculation is reported rather than hidden.
    """
    if extent <= 0:
        raise ValueError(f"extent must be positive, got {extent}")
    r = value / extent
    if not 0.0 <= r <= 1.0:
        if warnings is not None:
            warnings.append(
                f"{label}: {value}/{extent} = {r:.6f} is outside 0.0-1.0 and was clamped — "
                f"this crop was measured against the wrong extent, recompute it"
            )
        r = min(1.0, max(0.0, r))
    s = f"{r:.9f}".rstrip("0")
    s = s + "0" if s.endswith(".") else s
    if not _BARE_NUMBER.match(s):
        raise AssertionError(f"ratio() produced {s!r}, which is not a bare 0.0-1.0 JSON number")
    return s


def emit_json(
    filename: str,
    w: int,
    h: int,
    crops: list[tuple[str, Container]],
    warnings: list[str] | None = None,
) -> str:
    """Serialize to the canonical §14.7 shape (OUT-15) by hand, because the
    exact decimal text matters and json.dumps would normalise it away.

    Hand-serialising is also how a quoted coordinate gets in, so every
    coordinate goes through `ratio()` and the finished text is checked for
    quoted x/y before it is returned."""
    L = [
        "{",
        '  "format": "four-point-crop",',
        '  "version": "1.0",',
        '  "image": {',
        f'    "filename": {json.dumps(filename)},',
        f'    "width": {w},',
        f'    "height": {h}',
        "  },",
        '  "coordinateSystem": "normalized",',
        '  "crops": [',
    ]
    for i, (reason, c) in enumerate(crops):
        cid = f"crop-{i + 1:02d}"  # OUT-08
        # x always divides by the page WIDTH and y by the page HEIGHT, both
        # taken from the same w/h emitted in the image block above.
        X0 = ratio(c.x0, w, warnings, f"{cid} x0")
        X1 = ratio(c.x1, w, warnings, f"{cid} x1")
        Y0 = ratio(c.y0, h, warnings, f"{cid} y0")
        Y1 = ratio(c.y1, h, warnings, f"{cid} y1")
        pts = [("P1", X0, Y0), ("P2", X1, Y0), ("P3", X1, Y1), ("P4", X0, Y1)]
        L += [
            "    {",
            f'      "id": "{cid}",',
            f'      "reason": {json.dumps(reason)},',
            '      "crop": {',
            '        "mode": "rectangle",',
            '        "points": [',
        ]
        for j, (pid, px, py) in enumerate(pts):
            L += [
                "          {",
                f'            "id": "{pid}",',
                f'            "x": {px},',   # NO quotes: JSON number
                f'            "y": {py}',    # NO quotes: JSON number
                "          }" + ("," if j < 3 else ""),
            ]
        L += ["        ]", "      }", "    }" + ("," if i < len(crops) - 1 else "")]
    L += ["  ]", "}"]

    out = "\n".join(L) + "\n"
    if _QUOTED_COORD.search(out):
        raise AssertionError("emit_json produced a quoted coordinate — coordinates must be numbers")
    return out


# ───────────────────────────── VAL: checklist ────────────────────────────
def is_json_number(v) -> bool:
    """Exactly the downstream test: typeof v === 'number' && !Number.isNaN(v).

    `json.loads` turns 0.018 into a float and "0.018" into a str, so this is
    what separates a coordinate from a numeral in quotes. Booleans are
    excluded because Python calls them ints, and non-finite values are
    excluded because Python's json accepts the NaN and Infinity literals
    that JSON.parse rejects.
    """
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _type_name(v) -> str:
    if isinstance(v, float) and not math.isfinite(v):
        return "NaN" if math.isnan(v) else "Infinity"
    return {str: "string", bool: "boolean", type(None): "null"}.get(type(v), type(v).__name__)


def validate(text: str, w: int, h: int) -> list[str]:
    """§15 sections G, H and I — the machine-checkable half of the checklist.

    Safe on any input, including hand-written or model-written documents:
    every field is type-checked before it is compared, so a quoted
    coordinate is reported as a problem instead of raising TypeError.
    """
    problems: list[str] = []
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        return [f"I: JSON does not parse: {e}"]

    if not isinstance(doc, dict):
        return ["I: top level is not an object"]
    if doc.get("format") != "four-point-crop":
        problems.append("I: format field wrong")
    if doc.get("coordinateSystem") != "normalized":
        problems.append("I: coordinateSystem field wrong")

    img = doc.get("image")
    if not isinstance(img, dict):
        problems.append("I: image block missing or not an object")
    else:
        for key in ("width", "height"):
            if not is_json_number(img.get(key)):
                problems.append(
                    f"I: image.{key} is {_type_name(img.get(key))}, must be a number"
                )
        if is_json_number(img.get("width")) and is_json_number(img.get("height")):
            if img["width"] != w or img["height"] != h:
                problems.append(
                    f"I: image dimensions {img['width']}x{img['height']} do not match "
                    f"the measured page {w}x{h} — every coordinate normalized against "
                    f"them is wrong"
                )

    crops = doc.get("crops")
    if not isinstance(crops, list):
        problems.append("I: crops is missing or not an array")
        return problems

    seen_ys, x_pairs = [], []
    for i, crop in enumerate(crops, start=1):
        cid = crop.get("id", f"#{i}") if isinstance(crop, dict) else f"#{i}"
        if not isinstance(crop, dict):
            problems.append(f"I: {cid} is not an object")
            continue
        if cid != f"crop-{i:02d}":
            problems.append(f"I-2: {cid} breaks contiguous crop-NN numbering")
        if not crop.get("reason"):
            problems.append(f"I-2: {cid} has no reason")

        shape = crop.get("crop")
        if not isinstance(shape, dict):
            problems.append(f"I: {cid} has no crop object")
            continue
        if shape.get("mode") != "rectangle":
            problems.append(f"I: {cid} mode is not rectangle")

        pts = shape.get("points")
        if not isinstance(pts, list) or len(pts) != 4 or not all(isinstance(p, dict) for p in pts):
            problems.append(f"H: {cid} points must be an array of 4 objects")
            continue
        if [p.get("id") for p in pts] != ["P1", "P2", "P3", "P4"]:
            problems.append(f"H: {cid} point set/order wrong")
            continue

        # --- typing, before any comparison. A quoted numeral is the single
        # most common way this format breaks: the consumer checks
        # `typeof pt.x === 'number'`, which a string fails outright.
        mistyped = False
        for p in pts:
            for axis in ("x", "y"):
                v = p.get(axis)
                if not is_json_number(v):
                    mistyped = True
                    hint = (
                        " — drop the quotes, coordinates are JSON numbers"
                        if isinstance(v, str)
                        else ""
                    )
                    problems.append(
                        f"H: {cid} {p['id']}.{axis} is {_type_name(v)} ({v!r}), "
                        f"must be a number{hint}"
                    )
        if mistyped:
            continue

        P = {p["id"]: (float(p["x"]), float(p["y"])) for p in pts}
        for pid, (x, y) in P.items():
            for axis, v in (("x", x), ("y", y)):
                if not 0.0 <= v <= 1.0:
                    extent = "width" if axis == "x" else "height"
                    problems.append(
                        f"H: {cid} {pid}.{axis} = {v} is outside 0.0-1.0 — normalized "
                        f"against something other than image.{extent} (a single segment, "
                        f"a pre-resize size, or {axis} divided by the other extent)"
                    )
        if any(not 0.0 <= v <= 1.0 for xy in P.values() for v in xy):
            continue

        if P["P1"][0] != P["P4"][0] or P["P2"][0] != P["P3"][0]:
            problems.append(f"H: {cid} left/right edges are not vertical")
        if P["P1"][1] != P["P2"][1] or P["P3"][1] != P["P4"][1]:
            problems.append(f"H: {cid} top/bottom edges are not horizontal")
        if P["P2"][0] <= P["P1"][0] or P["P4"][1] <= P["P1"][1]:
            problems.append(f"H: {cid} has zero or negative extent")

        seen_ys.append(P["P1"][1])
        x_pairs.append((P["P1"][0], P["P2"][0]))

    if seen_ys != sorted(seen_ys):
        problems.append("I-2: crops are not sorted top-to-bottom by P1.y (OUT-07)")
    if len(x_pairs) > 1 and len(set(x_pairs)) == 1:
        problems.append("G: every crop shares identical X values — probable IX-01 failure (OUT-13)")

    return problems


# ───────────────────────────── debug output ──────────────────────────────
def write_overlay(rgb: np.ndarray, kept, skipped, path: Path, polarity: str = "dark") -> None:
    from PIL import ImageDraw

    # Neon reads on black and vanishes on white, so pick per polarity.
    if polarity == "light":
        keep_c, review_c, drop_c = (0, 140, 70), (190, 110, 0), (200, 0, 0)
    else:
        keep_c, review_c, drop_c = (0, 230, 120), (255, 190, 0), (255, 60, 60)

    im = Image.fromarray(rgb)
    d = ImageDraw.Draw(im)
    for i, (reason, c) in enumerate(kept):
        colour = review_c if "review" in reason else keep_c
        d.rectangle([c.x0, c.y0, c.x1 - 1, c.y1 - 1], outline=colour, width=6)
        d.text((c.x0 + 12, c.y0 + 12), f"crop-{i + 1:02d} {reason}", fill=colour)
    for reason, c in skipped:
        d.rectangle([c.x0, c.y0, c.x1 - 1, c.y1 - 1], outline=drop_c, width=3)
        d.text((c.x0 + 12, c.y0 + 12), reason, fill=drop_c)
    im.save(path)


def write_thumbs(rgb: np.ndarray, kept, out_dir: Path) -> None:
    """Cheap review assets: one small PNG per crop for the SR model pass."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, (_, c) in enumerate(kept):
        tile = Image.fromarray(rgb[c.y0:c.y1, c.x0:c.x1])
        tile.thumbnail((512, 512))
        tile.save(out_dir / f"crop-{i + 1:02d}.png")


# ───────────────────────────────── main ──────────────────────────────────
def detect(paths: list[Path], cfg: Config | None = None, *, background: str = "auto", **overrides):
    """Measure the page, pick a polarity profile, then run the geometry.

    `background` is "auto", "dark" or "light". Explicit `cfg` or keyword
    overrides always win over the profile.
    """
    rgb, offsets = stitch(paths)
    h, w = rgb.shape[:2]

    probe = cfg or Config()
    measured, source = measure_background(rgb, probe)
    pinned = overrides.get("bg_level")
    if pinned is None and cfg is not None:
        pinned = cfg.bg_level          # a caller-built Config may already carry one
    level = measured if pinned is None else int(pinned)   # 0 is a legal level
    polarity = background if background in ("dark", "light") else polarity_of(level)

    if cfg is None:
        cfg = Config.profile(polarity, **overrides)
    elif overrides:
        cfg = replace(cfg, **{k: v for k, v in overrides.items() if v is not None})
    cfg = replace(cfg, bg_level=level)

    masks = build_masks(rgb, cfg)
    overlay = detect_overlays(masks, cfg)
    containers = find_containers(masks, overlay, cfg)

    kept, skipped = [], []
    for c in containers:
        keep, verdict = sr_gate(c, cfg)
        if keep:
            tag = describe(c, w)
            if verdict.startswith("review"):
                tag = f"{tag}__review"
            kept.append((tag, c))
        else:
            skipped.append((verdict, c))

    page = {
        "bg_level": level,
        "bg_source": "pinned" if pinned is not None else source,
        "polarity": polarity,
        "bg_mode": cfg.bg_mode,
        "notes": masks["notes"],
    }
    return rgb, (h, w), offsets, kept, skipped, page


def check_file(path: Path, images: list[Path]) -> int:
    """Validate an existing four-point-crop document and report why it fails.

    Point this at JSON from anywhere — a model, a hand edit, another tool.
    With page images supplied the image block is cross-checked against the
    real page; without them the document is checked against its own
    dimensions, which still catches typing, range, ordering and geometry.
    """
    if not path.exists():
        print(f"no such file: {path}", file=sys.stderr)
        return 1
    text = path.read_text()
    if images:
        rgb, _ = stitch(images)
        h, w = rgb.shape[:2]
    else:
        try:
            img = json.loads(text).get("image", {})
            w, h = int(img.get("width", 0)), int(img.get("height", 0))
        except (json.JSONDecodeError, TypeError, ValueError):
            w = h = 0

    problems = validate(text, w, h)
    print(f"checking {path} against page {w}x{h}" + ("" if images else " (self-reported)"))
    if problems:
        print(f"\n{len(problems)} VALIDATION PROBLEM(S):", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    print("validation passed")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("images", nargs="*", type=Path, help="page segments, top to bottom")
    ap.add_argument("-o", "--out", type=Path, help="output JSON path")
    ap.add_argument(
        "--check",
        type=Path,
        metavar="CROPS.JSON",
        help="validate an existing four-point-crop JSON and exit",
    )
    ap.add_argument("--overlay", type=Path, help="write an annotated debug PNG here")
    ap.add_argument("--thumbs", type=Path, help="write per-crop thumbnails here for SR review")
    ap.add_argument("--name", help="override image.filename in the output")
    ap.add_argument(
        "--background",
        choices=("auto", "dark", "light"),
        default="auto",
        help="pin the tuning profile; auto measures the page (default: auto)",
    )
    ap.add_argument("--bg-level", type=int, help="pin the page background luma (0-255)")
    ap.add_argument("--gutter-tol", type=int, help="luma distance from bg still counted as page")
    ap.add_argument(
        "--bg-mode",
        choices=("color", "connected"),
        help="how gutter pixels become the page region (see resolve_background)",
    )
    ap.add_argument("--min-panel-area", type=int)
    args = ap.parse_args(argv)

    if args.check:
        return check_file(args.check, args.images)
    if not args.images:
        ap.error("at least one page image is required (or use --check)")
    if not args.out:
        ap.error("-o/--out is required")

    rgb, (h, w), offsets, kept, skipped, page = detect(
        args.images,
        background=args.background,
        bg_level=args.bg_level,
        gutter_tol=args.gutter_tol,
        bg_mode=args.bg_mode,
        min_panel_area=args.min_panel_area,
    )
    name = args.name or args.images[0].name
    warnings: list[str] = []
    text = emit_json(name, w, h, kept, warnings)

    problems = validate(text, w, h)  # §15 — never export unvalidated
    args.out.write_text(text)

    if args.overlay:
        write_overlay(rgb, kept, skipped, args.overlay, page["polarity"])
    if args.thumbs:
        write_thumbs(rgb, kept, args.thumbs)

    print(f"page {w}x{h} from {len(args.images)} segment(s) at y={offsets}")
    print(
        f"background luma {page['bg_level']} ({page['bg_source']}) "
        f"-> {page['polarity']} page, bg_mode={page['bg_mode']}"
    )
    for note in page["notes"]:
        print(f"  note: {note}")
    for i, (reason, c) in enumerate(kept):
        span = "full-width" if c.x0 <= 2 and c.x1 >= w - 2 else f"inset x{c.x0}-{c.x1}"
        print(f"  crop-{i + 1:02d}  y {c.y0:>5}-{c.y1:<5}  {span:<18} {reason}")
    for reason, c in skipped:
        print(f"  ----      y {c.y0:>5}-{c.y1:<5}  {'':<18} {reason}")

    for warn in warnings:
        print(f"  clamped: {warn}", file=sys.stderr)

    if problems or warnings:
        print("\nVALIDATION PROBLEMS:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1

    print(f"\nvalidation passed -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```
