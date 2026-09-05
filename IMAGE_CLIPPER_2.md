# Image Clipper 2.0 (Crop Pointers)

Module 3 v2: a parallel cropping technique that splits "where are the crops?" from
"cut the images" into two stages joined by a JSON file on disk.

The JSON file is not a cache. It is the module's user-visible artifact: you can read it,
hand-edit it, download it, and re-apply it without ever running detection again.

**Three ways to get pointers, one artifact.** The guidelines document
(`server/ml/CROP_POINT_GUIDELINES.md`) is the prompt for the two model paths:

| | **Manual** (primary) | **In-app** | **Offline** |
|---|---|---|---|
| Who runs the model | you, in ChatGPT / Claude / any chat | the server, against Gemini | nobody — classical CV |
| How the pages get there | already attached to the chat (Narration Studio Step 1) | uploaded per detection run | read from disk |
| How the result arrives | you drop the JSON in | written straight to disk | written straight to disk |
| Endpoint | `POST …/points/import` | `POST …/detect` | `POST …/detect {"engine":"offline"}` |
| Needs `GEMINI_API_KEY` | no | yes | no |
| Reads the artwork | yes | yes | **no** — measures where it is |

All three land in the same `crop_points.json` and are reviewed, edited and applied
identically. The manual loop exists because a chat session that already holds the
chapter's pages — the one used to write the narration script — produces better pointers
than an API call that re-uploads downscaled thumbnails, and it costs no quota.

The offline engine (`server/ml/crop_detect.py`, §5.2) is the one that does not involve a
model at all. It finds section boundaries from the page's own structure, so it needs no
key and no quota and measures the *source* pixels rather than a 1536px upload — but it
reads geometry, not meaning: where Gemini names a section `framed_hand_scene`, it names
it `inset_wide_scene`, and "is this section worth keeping?" (`SR-05`) is something it can
only flag for review. Use it for a fast first pass, when quota is gone, or as a
second opinion on a chapter a model already cut.

## 1. What it is, and how it differs from v1

| | Module 3 AI (v1) | Image Clipper 2.0 (v2) |
|---|---|---|
| What detection returns | crop **rectangles** (`canvasX/Y/W/H`) | **four pointers** per section (P1..P4) |
| Where the result lands | straight into the DB as `AISuggestion.rectJson` rows | a `four-point-crop` JSON file on disk |
| Who cuts the pixels | the workspace, after accept/reject → `finalizeSession` | a deterministic apply stage that reads only the JSON |
| Detection engine | Gemini vision (network) | Gemini vision (network) |
| Guidelines document | `server/ml/CROP_GUIDELINES.md` (a prompt) | `server/ml/CROP_POINT_GUIDELINES.md` (a prompt) |
| Export folder | `<chapter>/crops/` | `<chapter>/crops2/` |
| Entry point | `services/ai/guidelineCropService.ts` (untouched by v2) | `services/clipper2/*` |

v1 has one stage: the model's answer *is* the database state. v2 has two, and the boundary
between them is a file — so a bad detection is fixed by editing text, not by re-running
detection, and the apply stage has no model call in it at all.

```text
  STAGE 1 — detect (Gemini vision, windowed calls)
  ┌────────────────────────────────────────────────────────────────┐
  │  chapter pages, windowed (6 pages/call, 1-page overlap)         │
  │            ↓  + Crop Detection Guidelines as the prompt         │
  │  Gemini → four page-local pointers (P1..P4) per section         │
  │            ↓  reason, confidence, optional note                │
  │  lift page-local ratios → canvas pixels, per-point page width   │
  │            ↓  outer axis-aligned box (AN-02/CB-03)              │
  │  2D duplicate removal → normalize ONLY here (OUT-01..OUT-11)    │
  │            ↓  validate                                         │
  └────────────────────────────────────────────────────────────────┘
                               ↓
        <DOWNLOAD_ROOT>/<chapter>/crop_points/crop_points.json   ← THE CONTRACT
        <DOWNLOAD_ROOT>/<chapter>/crop_points/crop_points.meta.json  (provenance)
                               ↓
                    (optional) hand-edit / download / re-upload
                               ↓
  STAGE 2 — apply (deterministic: no model, no network)
  ┌────────────────────────────────────────────────────────────────┐
  │  validate → resolve pointers against the LIVE manifest         │
  │  → round edges → sharp extract/stitch → watermark white-fill   │
  │  → <chapter>/crops2/<series-slug>_pts_NNN.png                  │
  │  → (optional) register into the chapter's CropSession          │
  └────────────────────────────────────────────────────────────────┘
                               ↓
                    Module 4 (Video Editor) sees the crops
```

### Source layout

| File | Role |
|---|---|
| `server/src/services/clipper2/fourPointTypes.ts` | The contract. Every type and constant in the module comes from here. |
| `server/src/services/clipper2/fourPointSchema.ts` | Parse, validate, normalize/repair, serialize; normalized↔canvas geometry; 2D duplicate rules. |
| `server/src/services/clipper2/pointerGuidelines.ts` | The guidelines file: read paths, the 0444 lock, the single writer, reset. |
| `server/src/services/clipper2/pointerDetector.ts` | Stage 1, in-app. Lifts Gemini's page-local pointers to canvas pixels and composes the artifact. |
| `server/src/services/clipper2/geminiPointerDetector.ts` | The Node ↔ Gemini bridge: prompt windowing, the model call, response parsing. Knows nothing about the contract. |
| `server/src/services/clipper2/offlineDetector.ts` | Stage 1, offline (§5.2). The Node ↔ Python bridge; turns the sidecar's canvas rects into the artifact through `fourPointSchema`. |
| `server/ml/crop_detect.py` | The offline detector's pixels. Returns canvas rects; knows nothing about `four-point-crop`. |
| `server/ml/test_crop_detect.py` | Its geometry tests — canvas scaling, per-page polarity, sectioning. |
| `client/src/components/clipper2/PointerImport.tsx` | The manual loop's two pieces — copy the prompt, drop the JSON — shared by both surfaces that offer it. |
| `server/src/services/clipper2/pointerApply.ts` | Stage 2. Cuts with `clipperService`, registers into the `CropSession`. |
| `server/src/services/clipper2/pointerStore.ts` | Where the artifact lives and how its bytes are produced. Paths and bytes only. |
| `server/src/routes/clipper2.ts` | HTTP surface + Socket.io emissions, mounted at `/api/clipper2`. |
| `server/ml/CROP_POINT_GUIDELINES.md` | The **active** prompt, sent verbatim by both paths. |
| `server/ml/CROP_POINT_GUIDELINES.default.md` | The shipped default; copied out of, never written. |
| `client/src/lib/api.ts` → `clipper2Api` | Typed client for every endpoint below. |
| `client/src/pages/Settings.tsx` → `CropPointGuidelinesCard` | The only UI that can change the guidelines (Settings → **Crop Pointers**). |
| `client/src/pages/narration/ScriptEditor.tsx` → manual tab | Steps 3 & 4: copy the prompt into the script chat, attach the JSON that comes back. |
| `server/prisma/schema.prisma` → `CropPointSet` | Index row for listing/status. **Not** the source of truth for geometry. |
| `server/src/services/clipper2/__tests__/fourPointSchema.test.ts` | Vitest coverage of the schema half. |

> The `CropPointSet` row exists so the chapter list can render without reading every
> chapter's folder. Every handler that answers a question *about the pointers* reads the
> disk; nothing reconstructs geometry from the database.

## 2. The `four-point-crop` v1.0 artifact

Written to, per chapter:

```
<DOWNLOAD_ROOT>/<Series Title>/Chapter XXX/crop_points/crop_points.json        # canonical
<DOWNLOAD_ROOT>/<Series Title>/Chapter XXX/crop_points/crop_points.meta.json   # sidecar
```

`crop_points.json` is the canonical artifact whose shape is fixed by §14 of the guidelines
and by `FourPointCropFile`. `crop_points.meta.json` is deliberately **outside** that shape
(§14 has no room for provenance): it carries `source`, `model`, `guidelinesSha`,
`detectedAt`, the ordered stitched `segments` (`ST-10`), detection `warnings`, and the
per-crop `confidenceById` map. A missing *or corrupt* sidecar is never fatal — apply
rebuilds the segment map from the chapter folder.

### Canonical shape

```json
{
  "format": "four-point-crop",
  "version": "1.0",
  "image": {
    "filename": "Chapter 012 [stitched:4]",
    "width": 800,
    "height": 8192
  },
  "coordinateSystem": "normalized",
  "crops": [
    {
      "id": "crop-01",
      "reason": "full_width_forest_scene",
      "crop": {
        "mode": "rectangle",
        "points": [
          {
            "id": "P1",
            "x": 0.0,
            "y": 0.061035156
          },
          {
            "id": "P2",
            "x": 1.0,
            "y": 0.061035156
          },
          {
            "id": "P3",
            "x": 1.0,
            "y": 0.378417969
          },
          {
            "id": "P4",
            "x": 0.0,
            "y": 0.378417969
          }
        ]
      }
    },
    {
      "id": "crop-02",
      "reason": "framed_hand_scene",
      "crop": {
        "mode": "rectangle",
        "points": [
          {
            "id": "P1",
            "x": 0.065,
            "y": 0.401123047
          },
          {
            "id": "P2",
            "x": 0.7275,
            "y": 0.401123047
          },
          {
            "id": "P3",
            "x": 0.7275,
            "y": 0.512451172
          },
          {
            "id": "P4",
            "x": 0.065,
            "y": 0.512451172
          }
        ]
      }
    }
  ]
}
```

- `version` is the **JSON format** version (`1.0`), independent of the guidelines
  document's own version.
- `image` describes the page actually measured (`OUT-14`). For a multi-page chapter that is
  the **combined** canvas (width = widest page, height = sum of page heights), and
  `filename` is the synthetic label `<chapter folder> [stitched:N]` — there is no single
  file on disk with those dimensions.
- `crops: []` is a meaningful, valid result: "no section qualified" (`OUT-16`).

### Point order

```text
P1 ───────▶ P2        P1 top-left      P1.x == P4.x   (left edge)
 ▲          │         P2 top-right     P2.x == P3.x   (right edge)
 │          ▼         P3 bottom-right  P1.y == P2.y   (top edge)
P4 ◀─────── P3        P4 bottom-left   P3.y == P4.y   (bottom edge)
```

The order is fixed (`POINT_IDS`, §14.5) and the equalities are validated with **exact**
equality (§13.1). Only `normalizeCropFile` is allowed to forgive a near-miss; if validation
forgave them too, a file could be "valid" while the cut differed from the file.

### Serialization rules, and why `JSON.stringify` cannot do it

`serializeCropFile` in `fourPointSchema.ts` is a hand-rolled writer, and it is the only
canonical serializer (`writePointsFile` is its only caller). `JSON.stringify` cannot
produce the required bytes:

| Rule | Requirement | Why `JSON.stringify` fails |
|---|---|---|
| `OUT-15` | 2-space indent; root key order `format`, `version`, `image`, `coordinateSystem`, `crops`; point key order `id`, `x`, `y` | indentation is fine, but key order depends on object insertion order rather than being guaranteed by the format |
| `OUT-15` | every point object **expanded** across multiple lines, as in §14.7 | `stringify(…, null, 2)` would also expand, but only as a side effect of its uniform policy — the shape is not stated anywhere |
| `OUT-11` | exact bounds render as `0.0` and `1.0`, never bare `0`/`1` | `JSON.stringify(0)` is `"0"`, and JSON has no way to express "this number keeps a decimal point" |
| `OUT-10` | the exact ratio to at most 9 dp, trailing zeros stripped, never exponential | a very small ratio serializes as `1e-7`; rounding is done with `toFixed` for exactly this reason |

`renderRatio` is the enforcement point: integers render via `toFixed(1)` (`0.0`, `1.0`) and
everything else via `toFixed(9)` with trailing zeros stripped. `formatRatio` collapses `-0`
so `"-0.0"` can never appear. 9 dp is a **ceiling, not a target**: `0.244140625` (= 500 ÷
2048) must survive unrounded.

One deliberate exception: `writePointsText` writes the user's own keystrokes through
untouched, because reformatting a file someone is mid-edit on would fight them. Text is
therefore validated on read, not on write — and `PUT /points` re-serializes canonically on
save, so a committed hand-edit ends up diffable against a detected one.

## 3. Page-local → combined-logical-page coordinates

The model is asked for **page-local** coordinates; the artifact stores **combined-page**
coordinates. Both halves are deliberate.

**Why the model reports page-local.** It never sees a stitched canvas — `pointerDetector`
sends discrete page thumbnails labelled `Page N of M` with each page's true pixel size. A
fraction down one 2048px page is a far finer measurement than the same edge expressed as a
fraction of a 12 000px chapter, and the model has no way to know a page's offset within a
canvas it was never shown. So:

- `P1.y` / `P2.y` are fractions down `startPage`
- `P3.y` / `P4.y` are fractions down `endPage` (`startPage !== endPage` is valid and
  expected — `ST-04`, `ST-05`; a page boundary is never itself a crop boundary, `ST-03`)
- `x` is a fraction across the page width

**Why the artifact stores combined-page.** `ST-09`: for a multi-image page the exported
coordinate system must represent the combined logical page. That is also the only system in
which the four y values are comparable at all — before conversion, `P1.y` and `P3.y` can
live in two different pages' coordinate spaces.

### The combined canvas is *scaled*, not raw-stacked

This is the part that is easy to get wrong, and was wrong until recently. Chapters arrive as
slices of the same logical page encoded at **different widths** — 713, 800 and 968px in one
real chapter here, and 8 of 32 local chapters mix widths at all. They are the same content
width, just different encodings.

So `getChapterManifest` scales every slice up to the widest one:

```text
W_ref   = max(w_i)                      the reference width — the canvas width
scale_i = W_ref / w_i                   always >= 1
H_i     = h_i * scale_i                 that slice's height ON THE CANVAS
canvasY_i = Σ H_0..i-1                  offsets accumulate SCALED heights
canvasHeight = Σ H_i
```

Stacking raw heights instead — which is what the code did before — leaves a narrower page as
a short column with dead space to its right, makes `x = 1.0` point past the artwork, and
produces a canvas ~21% shorter on a mixed-width chapter. A pointer file written against one
layout is grossly wrong under the other; at mid-chapter the two disagree by **16 000–31 000
pixels**.

The consequence is that `ManifestImage` carries both spaces, and confusing them is the bug to
watch for:

| field | space | used for |
|---|---|---|
| `width` / `height` | SOURCE pixels | what `sharp` extracts from |
| `canvasY` / `canvasHeight` | CANVAS pixels | what crop rectangles are in |
| `scale` | ratio | converts between them (`canvas = source * scale`) |

`computeCropFromCanvas` divides every extent by `scale` on the way to sharp;
`executeCrop` multiplies back up so an exported crop is canvas-sized whichever slice it came
from. On a uniform-width chapter every `scale` is 1 and all of this is the identity — which
is exactly why the bug went unnoticed.

### The lift

`canvasRectFromPointers` (in `pointerDetector.ts`) does the lift, in canvas pixels:

```text
y_canvas = page.canvasY + clamp01(point.y) * page.canvasHeight   (startPage for P1/P2, endPage for P3/P4)
x_canvas = clamp01(point.x) * manifest.canvasWidth
```

`y` resolves against each point's **own page's canvas extent**, because a crop may span a seam
and the two pages can have different scaled heights. `x` resolves against the full canvas
width, because a scaled page spans all of it.

The lift then takes the axis-aligned **outer** box (`min`/`max` over the four points). Outer,
not inner: the artifact must be a rectangle (`AN-02`) placed on the outer edge of an angled
boundary (`AN-03`), so a model that reports slightly unequal edges is resolved outwards rather
than inwards into the container (`CB-03`). `entryFromCanvasRect` then divides back down by the
combined canvas to store ratios.

The round trip is stable because it is normalized: `pointerApply` always resolves against
the **live** manifest, never against `image.width`/`image.height` from the file, so a
chapter re-served at a different resolution still crops correctly (`OUT-14` — a mismatch is
reported as a warning, not a failure).

## 4. The guidelines document

The document is handed to Gemini **verbatim**, as the prompt Stage 1 sends alongside each
window of page images (identical in spirit to v1's `guidelineCropService.ts`, which does the
same for rectangle suggestions). Its rule IDs (`OUT-08`, `IX-01`, `ST-09`, `AN-02`, …) are
cited throughout the detector and the validator, which enforce the parts of the contract a
model's prose can't be trusted to hold exactly — point order, rectangularity, id
contiguity — regardless of how well the model followed the prompt.

So editing it changes behaviour on the very next detection run. Each run also records the
document's `sha256`, which is what lets a point set be traced back to the revision of the
rules it was produced under. A missing document is not fatal — detection still runs, on
Gemini's general cropping judgement — but it is recorded as a warning, since the rules that
were actually applied are un-traceable.

| File | Role |
|---|---|
| `server/ml/CROP_POINT_GUIDELINES.md` | The **active** specification. Stored `0444`. |
| `server/ml/CROP_POINT_GUIDELINES.default.md` | The shipped default (currently document v2.4). Copied out of, never written. |
| `server/ml/crop_point_guidelines.meta.json` | Sidecar recording `updatedAt` + `sha256` of the active document. |

The immutability contract (identical in shape to v1's in `services/ai/guidelineCropService.ts`):

- Every detection path only ever calls `readPointerGuidelines()`, and only to hash it.
  Nothing on the detect/apply path writes the file. Each run records the `sha256` it saw in
  the sidecar and on the `CropPointSet` row (`guidelinesSha`).
- The **single writer** is `writePointerGuidelines()`, reached only from
  `PUT /api/clipper2/guidelines` — i.e. only from the Settings card. It unlocks (`0644`),
  writes, refreshes the meta sidecar, and re-locks (`0444`).
- `ensurePointerGuidelines()` is the one non-user write, and it is restricted to the
  missing/empty case so it cannot clobber an edit: it seeds the active document from the
  default and re-locks. It runs, best-effort, on `GET /status` and `GET /guidelines`, which
  is why the Settings editor shows the shipped rules before any detection has ever run.
- `isDefault` is computed by comparing **content** hashes, not the sidecar, so a file edited
  outside the app still reports `isDefault: false`.

**To upgrade the rules:** Settings → *Image Clipper 2.0 (Crop Pointers)* → **Edit
guidelines** → **Save Guidelines**. The next detection run picks it up; runs already in
flight are unaffected (they hold the text they started with).

**To restore the default:** the same card's **Restore default** button
(`POST /guidelines/reset`), which copies `CROP_POINT_GUIDELINES.default.md` back through the
single writer. It discards your version — there is no undo.

## 5. HTTP endpoints and socket events

All routes are mounted at `/api/clipper2` (`initClipper2Routes(io)` in `server/src/index.ts`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/status` | Gemini availability, guidelines presence/`updatedAt`/`isDefault`, detection model, `format` + `formatVersion` |
| `GET` | `/guidelines` | The active document (seeds it first if absent) |
| `PUT` | `/guidelines` | `{ content }` — the **only** write path. 400 on empty |
| `POST` | `/guidelines/reset` | Restore the shipped default |
| `GET` | `/prompt` | `{ prompt }` — the exact text to paste into an external AI. Chapter-independent |
| `GET` | `/chapters` | Every `status: 'done'` chapter + pointer-set status (`hasPoints`, `cropCount`, `status`, `detectedAt`, `appliedAt`, `exportedCount`) |
| `POST` | `/chapters/:id/detect` | Start Stage 1. Body `{ engine?: 'gemini' \| 'offline', … }` (§5.2); returns `{ started: true, engine }`; 409 if already detecting |
| `POST` | `/chapters/:id/cancel` | Abort an in-flight detection → `{ cancelled: 0 \| 1 }` |
| `GET` | `/chapters/:id/points` | Artifact bytes as they sit on disk + `validation` + `sidecar` + `confidenceById` + row status |
| `PUT` | `/chapters/:id/points` | `{ content }` hand-edit, **strict**. Invalid JSON returns 400 **with the full `validation` report and is not written** |
| `POST` | `/chapters/:id/points/import` | `{ content }` from an external AI. **Repairs before validating**; returns the set plus the `repairs` it applied |
| `DELETE` | `/chapters/:id/points` | Drop the artifact, sidecar and index row. Exported PNGs are kept |
| `GET` | `/chapters/:id/points/download` | The exact bytes as `ch<N>_crop_points.json` |
| `POST` | `/chapters/:id/apply` | Start Stage 2. Body `{ register?, replaceExisting? }`; 400 for no/invalid artifact, 409 if already applying |
| `POST` | `/chapters/:id/preview/:cropId` | `{ preview }` data-URI thumbnail for one pointer set, resolved exactly as apply would |
| `GET` | `/chapters/:id/outputs` | `{ exportDir, files: [{ filename, bytes, url }] }` from `crops2/` |
| `GET` | `/chapters/:id/output/:filename` | One exported PNG, scoped to that chapter's `crops2/` |

Both stages are fire-and-forget: the HTTP response says only that the job started, and
every outcome — success *or* failure — arrives on the socket.

| Event | Payload |
|---|---|
| `clipper2:detect-progress` | `{ chapterId, phase, percent, message? }` — phases: `manifest`, `detect`, `write` |
| `clipper2:detect-complete` | `{ chapterId, cropCount?, warnings?, error? }` |
| `clipper2:apply-progress` | `{ chapterId, current, total }` |
| `clipper2:apply-complete` | `{ chapterId, exported?, failed?, exportDir?, registered?, warnings?, error? }` |

The client already consumes all four in `client/src/lib/socket.tsx`
(`clipper2DetectProgress`, `clipper2DetectComplete`, `clipper2ApplyProgress`,
`clipper2ApplyComplete`), and `clipper2Api` in `client/src/lib/api.ts` wraps every endpoint.

## 5.1 The manual loop

The path that produces the best pointers today. It runs in the chat that already holds
the chapter's pages — the one used to write the narration script — so the model is
reasoning about images it has already read rather than a fresh set of thumbnails.

1. **Narration Studio → chapter → Manual tab.** Steps 1–2 attach the pages and write the
   script, as before.
2. **Step 3 — Copy Pointer Prompt.** Copies `GET /prompt`: the line *"Now for the same
   above chapter Detect Pointers as per below guidelines"* followed by the active
   guidelines document verbatim (~55 000 characters). Paste it into the same chat.
3. **Step 4 — Attach the Pointer JSON.** Drop the file, or paste the raw reply — fences
   and surrounding prose are stripped. It `POST`s to `…/points/import`.
4. **Check in Image Clipper 2.0**, where the same two steps are also available in the
   workspace's *Get crop pointers* strip, so a chapter can be re-imported without going
   back to the narration page.

**Why import repairs and hand-edit does not.** `PUT /points` validates strictly: those
bytes came out of our own editor, so second-guessing them would be rewriting what the user
typed. An imported file is a foreign artifact, and a real model's output essentially never
satisfies §13.1's **exact** edge equality — a right edge of `0.72751` against a left edge of
`0.7275` is a rounding artifact, not a skewed quad. Rejecting a chapter over that would make
the loop unusable, so import runs the same repair pass detection uses (`normalizeCropFile`:
snap near-equal edges, re-sort into page order, renumber to `OUT-08`, snake_case the reasons)
and validates the *repaired* file. Anything the repair cannot rescue is still a 400, and the
file on disk is left untouched.

Every repair is returned and rendered, so "we changed your file" is never silent:

```text
§13.1   "crop-2": right, bottom snapped to the mean of near-equal points (tolerance 0.002)
OUT-07  Crops were re-sorted into top-to-bottom page order
OUT-08  "crop-1" renumbered to "crop-01"
OUT-09  "crop-2": reason normalized to "framed_hand_scene"
```

**The one check worth reading.** Coordinates are normalized, so a file whose `image`
describes a *different* canvas than the chapter is not merely mislabelled — every ratio in
it is divided by the wrong denominator and every crop lands in the wrong place. This is the
manual loop's characteristic failure: the AI measures one page instead of the whole stitched
chapter (`ST-09`). Absolute pixel sizes are a poor test, since the model sees downscaled
pages, but the aspect ratio survives any downscale, so import compares that against the live
manifest and warns when it is off by more than 2%:

```text
ST-09  The imported file measures a 800x20480 page, but this chapter's combined page is
       800x137159. If the AI measured one image instead of the whole stitched chapter,
       every coordinate is normalized against the wrong height — check the overlay
       before applying.
```

A warning, not an error: the overlay is right there, and a chapter genuinely can be one page
tall.

**Provenance.** An imported set records `source: 'ai'`, `model: 'external-ai (manual
import)'`, and the `sha256` of the guidelines as they stood when the prompt was copied — so
an imported point set is traceable to a rules revision exactly like a detected one. Per-crop
confidences are dropped, since the previous set's confidences describe crops that no longer
exist.

## 5.2 The offline engine

`POST /chapters/:id/detect` with `{"engine": "offline"}` runs
`server/ml/crop_detect.py` through the same spawn/JSON-envelope sidecar bridge v1 uses
(`services/ai/aiCropService.ts` → `runSidecar`), and emits the same
`clipper2:detect-*` events as the Gemini path. The route, the artifact, the sidecar, the
row and the apply stage are all unchanged — only `sidecar.source` (`cv`) and
`sidecar.model` (`offline-cv (crop_detect v1)`) say which engine ran.

**The split of responsibilities is the point.** The sidecar returns *canvas rects*, not
JSON. Everything after that — P1..P4, the `OUT-*` rules, normalization, validation, the
canonical bytes — goes through `fourPointSchema` exactly as `pointerDetector` does, via
`entryFromCanvasRect`. There is one emission format in the codebase, not two.

Nor does the script stitch. Geometry comes from the manifest it is handed, because the
canvas is *scaled*, not raw-stacked (§3): re-deriving it from the image files is what put
crops 16,000-31,000px out before. `test_crop_detect.py` pins this.

**The pipeline**, in `crop_detect.py`:

```text
manifest + page files
   ↓  build_canvas       downscale to detect_width (600), place each page at its canvasY
   ↓  normalize_polarity  per PAGE: invert a light-gutter page so one rule set covers both
   ↓  level_page          subtract each page's own measured gutter level
   ↓  build_masks         ink / white / coloured / luma
   ↓  detect_overlays     OV-01..OV-09: bubbles, narration boxes, watermark text
   ↓  section_spans       row profile → reading beats, merged across thin gutters
   ↓  split_columns       per section: side-by-side panels, or the section itself
   ↓  sr_gate             SR-04 drops branding; SR-05 flags flat art for review
canvas rects → offlineDetector.ts → fourPointSchema → crop_points.json
```

Two decisions in there are worth knowing about, because both were wrong first:

- **Polarity is per page, not per chapter.** A real chapter here opens on a dark splash
  (margin luma 27) and continues on white pages (209-255). Deciding once left over half
  the canvas with its gutter as foreground, the ink mask covering ~71% of the page, and
  component labeling merging whole pages into one blob.
- **Sections come from the row profile, not from connected components.** Measured across
  the hand-cut chapters in this library, 70-85% of sections are full width and 19-54%
  *overlap* their predecessor. Components cannot produce an overlapping full-width
  section at all; they are used only to tighten horizontal bounds within a section, which
  is what still catches the `framed_*` inset case.

**Accuracy.** Scored against the four chapters here whose artifacts match their folder:
~62% recall and ~61% precision at IoU ≥ 0.5, and 72-80% recall on three of the four. It
is a first pass to edit, not a finished cut — which is why it writes the same editable
artifact everything else does.

**Tunables** (all optional on the detect body, all bounded server-side):
`gutterMode` (`auto` | `dark` | `light`), `minPanelArea`, `breakoutMargin`,
`filterOverlays`. `GET /status` reports `offlineAvailable` / `offlineError`, which is a
real process probe — unlike `geminiAvailable`, which only checks for a key.

**Requirements.** The `server/ml/venv` from `npm run ml:setup` (numpy, Pillow, scipy). No
network, no GPU, no trained model. A full 24-page chapter takes ~15-20s.

## 6. The apply stage

`applyCropPoints()` throws only for conditions that make the whole run meaningless — an
invalid artifact, a missing chapter folder, an unusable manifest. Everything else is
reported through `ApplyResult.warnings`.

**Validation gate (three layers, all before any pixel is read).**

1. `POST /apply` reads and parses the artifact *before* responding: "there are no pointers"
   and "your edit does not parse" are answers to the request, not events to wait for. An
   invalid file returns 400 with its `validation` report.
2. `applyCropPoints` re-runs `validateCropFile` on the file it was handed — the artifact is
   a user-editable document, so its shape is re-established even when detection produced it
   minutes ago. Warnings are carried into the result; a single error aborts the run.
3. Per crop, `assertUsableRect` refuses non-finite geometry and any rect under 1×1 px. This
   matters because the pixel snapper clamps to a 1px minimum, which would otherwise turn a
   collapsed pointer set into a "successful" 1px sliver.

Edges are snapped by **rounding the edges, not the position and size independently** — so
two crops the guidelines treat as adjacent (`OUT-12`) stay flush instead of developing a
one-pixel seam — then clamped to the canvas so a pointer at exactly `1.0` cannot ask for a
row past the last page.

**Cutting.** `clipperService.executeCrop` does the work: single-file `sharp.extract` for a
crop inside one page, extract-and-composite for one that spans pages (`ST-04`, `ST-05`).
Nothing about stitching is reimplemented in Clipper 2.0.

**Watermark white-fill (reused, not rebuilt).** `detectChapterWatermarkRects(folderPath,
seriesId, manifest)` runs **once per apply**, exactly as `finalizeSession` does it, and the
canvas-space rects are handed to `executeCrop`, which white-fills only the rects falling
inside each crop. Best-effort: no watermark sidecar and no templates simply means no
white-fill, and a detection failure is logged and skipped rather than failing the run.

**Output naming and location.**

```
<DOWNLOAD_ROOT>/<Series Title>/Chapter XXX/crops2/<series-slug>_pts_001.png
```

`crops2/` is kept separate from v1's `crops/` so both techniques can be run over the same
chapter and compared without either overwriting the other's images. The number is the
crop's **position in the array**, 3-digit zero-padded — not its `id`, because a hand-edited
file may break `OUT-08` contiguity while export order is what the video editor consumes.
A crop that fails to cut increments `failed`, adds a warning, and never aborts the batch: a
chapter with one bad rectangle still exports the other forty.

**Registration into the `CropSession` (optional, default on).** With `register` not set to
`false`, apply mirrors the exported crops into the chapter's `CropSession`, which is what
makes them visible to Module 4:

- upsert the `CropSession`, then, if it already holds crops and `replaceExisting` is not
  `true`, **export but do not register** and say so in a warning — the existing manual or v1
  crops are somebody's work.
- otherwise replace the set wholesale (`deleteMany`, then one `Crop` row per exported image
  with `sequence`, canvas + normalized coords, `sourceFiles`, `aspectRatio: 'free'` and the
  absolute `exportPath`), log a `finalized` `CropEvent` per crop carrying
  `source: 'clipper2-pointers'` and the pointer crop's id/reason, and set the session to
  `cropCount` + `status: 'finalized'` — the status Module 4 expects on a session whose crops
  have export paths.

`DELETE /points` never touches `crops2/`: Module 4 may already be building a video from
those files.

## 7. Running it end to end

```bash
# Set GEMINI_API_KEY in .env (get one from https://aistudio.google.com/apikey)

# API on :3002, client on :5173 (from the repo root)
npm run dev
```

1. Download a chapter (Module 1) so its folder holds page images and its status is `done`.
2. Check the module is ready: `GET /api/clipper2/status` → `geminiAvailable: true`. Only the
   in-app path needs this; the manual loop works with no API key at all.
3. List candidates: `GET /api/clipper2/chapters` and pick a chapter id.
4. **Stage 1**, either way:
   - *Manual* — copy `GET /api/clipper2/prompt` into the chat holding the pages, then
     `POST /api/clipper2/chapters/<id>/points/import` with `{ "content": "<the reply>" }`.
     See §5.1; in the UI this is Narration Studio Steps 3–4, or the workspace strip.
   - *In-app* — `POST /api/clipper2/chapters/<id>/detect`, then watch
     `clipper2:detect-progress` / `clipper2:detect-complete`. Pages are sent to Gemini in
     windows of 6 (1-page overlap), so run time and rate-limit exposure scale with
     `ceil(pageCount / 5)` calls, not `pageCount`.
5. Inspect `GET /api/clipper2/chapters/<id>/points` — or open
   `<chapter>/crop_points/crop_points.json` directly. Fix anything wrong and save it back
   with `PUT …/points` (rejected outright if it does not validate), or check one region with
   `POST …/preview/crop-03`.
6. **Stage 2** — `POST /api/clipper2/chapters/<id>/apply` (add
   `{ "replaceExisting": true }` to overwrite crops already registered on the chapter), then
   watch `clipper2:apply-*`. Results land in `crops2/` and, when registered, in the Video
   Editor's crop pool.

Iterating on the pointers does not require re-detecting; iterating on detection does not
require re-cutting.

### Environment variables

| Variable | Used for | Default |
|---|---|---|
| `GEMINI_API_KEY` | Required **only for in-app detection** — the manual loop needs no key. Shared with Module 2 (Narration) and Module 3 v1 (AI Crop Lab) | *(none)* |
| `CLIPPER2_MODEL` | Model override for this module, independent of v1's `AI_CROP_MODEL` and narration's `AI_MODEL` — useful to dodge a per-model daily quota | `gemini-3.5-flash` |
| `DOWNLOAD_ROOT` | Root of every path in this document: source pages, `crop_points/`, `crops2/`. Relative by default, so the artifact's absolute path depends on the server's cwd | `./downloads` |

## 8. Known limits

Observed in the code as it stands, not a wish list.

1. **In-app detection's precision is bounded by the page image sent to Gemini.** Pages are
   downscaled to 1536px wide before upload; an edge finer than that is measured as accurately
   as the model can read a compressed JPEG, not as accurately as the source pixels. The manual
   loop is not subject to this — whatever resolution the chat received is what was measured.
2. **The pointer prompt is ~55 000 characters.** It is the whole guidelines document, so
   copying it into a chat with a short context window, or one that silently truncates a long
   paste, will produce pointers judged against only part of the rules. There is no truncation
   warning; the artifact's `guidelinesSha` records what was *offered*, not what was read.
3. **A hand-placed artifact is invisible to the listing.** `GET /chapters` only probes the
   disk when a `CropPointSet` row exists, so dropping a `crop_points.json` into a chapter
   that was never detected reports `hasPoints: false` until a `PUT …/points`, an import or an
   apply creates the row. `GET …/points` for that chapter reads it correctly.
4. **A window that exceeds `maxOutputTokens` mid-array is salvaged, not retried** (in-app
   path only). The parser keeps every complete crop object and drops the truncated tail, so a
   chapter with unusually dense sections in one window may under-return crops for that window
   specifically rather than failing outright.
5. **Rate limits are per free-tier model/day, not per chapter** (in-app path only). A long
   backlog of chapters detected back-to-back can exhaust the daily quota; the bridge retries a
   429 with the server's suggested delay (capped at 30s) up to twice, then surfaces the
   failure as a per-window warning rather than aborting chapters that already succeeded.
6. **An imported set carries no per-crop confidence.** The workspace's confidence badges are
   populated by in-app detection only; imports drop the map, so every crop reads as unscored
   rather than as scored-and-uncertain.
7. **`confidence: 0.5` is ambiguous.** Confidence survives normalization by geometric
   matching at IoU ≥ 0.9; anything unmatched — or a crop where the model omitted
   `confidence` — falls back to the neutral `0.5`, which is indistinguishable from a model
   that actually reported `0.5`.
8. **Apply cannot be cancelled**, only prevented from running twice (`applying` is a plain
   `Set`). Re-applying overwrites the same `crops2/` filenames.
9. **`replaceExisting: true` deletes every `Crop` row in the session**, including manual and
   v1 crops; only their exported PNGs survive, orphaned on disk.
10. **`image.filename` is synthetic for a stitched chapter** (`<folder> [stitched:N]`), so
    the canonical file alone cannot be resolved back to source files. The real ordered
    segment list lives only in the non-canonical sidecar, and apply re-derives it from the
    chapter folder — a consumer outside this module has neither.
11. **Hand-editing means editing combined-page coordinates.** The editor round-trips raw
    text faithfully, but there is no per-page view and no exposed page-local ↔ combined
    helper, so a human working from one page image converts by hand.
12. **The import's canvas check is an aspect-ratio heuristic.** An AI that measures the wrong
    page but happens to hit the same aspect ratio passes silently, and a chapter whose
    combined canvas genuinely matches one page's proportions can warn without cause.
13. **A scaled slice is upscaled on export, not resampled from better data.** A 713px slice on
    a 968px canvas is enlarged 1.36× when cut, so its crops carry no more detail than the
    source had — they are merely dimensionally consistent with crops from the wider slices.
    The alternative (exporting each crop at its slice's native size) would make output sizes
    vary within one chapter, which Module 4 would then have to reconcile.
14. **The guidelines document does not state the width rule.** `OUT-01` defines normalization
    and `ST-09` requires the combined page, but neither says how *unequal* widths combine, so
    an external AI has to infer it. Until §1.1 spells out reference-width scaling, a manual
    import on a mixed-width chapter depends on the model guessing the same convention the code
    uses — the aspect-ratio check above is what catches it when it does not.
13. **`0444` is a convention, not enforcement.** The lock is best-effort (`chmod` failures
    are swallowed for filesystems that do not support it) and the file's owner can still
    edit it directly; the module's only defence is that `isDefault` and `guidelinesSha` will
    show it happened.
