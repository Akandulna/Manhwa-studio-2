# Manhwa Crop Detection Guidelines

**Document version:** 2.4 (consolidated)
**Supersedes:** v1.1, v2.0
**Output format:** `four-point-crop` v1.0
**Reference output:** §14.7 — match this shape exactly
**Scope:** Long vertical manhwa / webtoon / comic pages

---

## 0. How to Use This Document

This is a **rule specification**, not prose. Every rule has a stable ID
(e.g. `CB-03`) so it can be cited in reviews, logs, and corrections.

Reading order for an implementer:

| Section | Purpose |
|---|---|
| §1.1 Stitched pages | How multiple source images form one logical page |
| §2 Glossary | Fixes the meaning of every term used below |
| §3 Core Principles | The five statements everything else derives from |
| §4 Priority Hierarchy | The single tie-breaker when rules conflict |
| §5 Pipeline | The execution order |
| §6–§14 | The rules themselves, grouped by pipeline stage |
| §15 Validation | Mandatory pre-export checklist |
| §16 Examples | Visual reference cases |
| §17 Training Log | Evidence trail — why each rule exists |
| §18 Rule Index | One-line lookup for every rule |

**Conformance keywords:** `MUST`, `MUST NOT`, `SHOULD`, `NEVER`, `ALWAYS`
carry their strict meaning. `NEVER` rules have no exceptions.

---

## 1. Objective

Detect four crop points that extract **meaningful visual sections** from a
long vertical manhwa page, reproducing manual human cropping behaviour.

A correct result:

1. Identifies a meaningful visual/story section — and skips anything that is not one.
2. Detects that section's **true** visual/container boundary on all four sides.
3. Excludes speech bubbles, narration boxes, SFX, and decorative overlays.
4. Preserves the complete visual event and its necessary context.
5. Removes unnecessary whitespace while preserving necessary container space.
6. Emits `P1 → P2 → P3 → P4` in the JSON format defined in §14.

### 1.1 Multi-Image Stitched Page Handling (`ST`)

Manhwa/webtoon content is often supplied as multiple image segments that
together represent one continuous vertically scrolling page. These segments
must be treated as **one logical page** for crop detection.

| ID | Rule |
|---|---|
| **ST-01** | When multiple supplied images are consecutive segments of the same manhwa page, treat them as **one continuous stitched page** before detecting crops. |
| **ST-02** | Determine crop sections using the combined top-to-bottom visual sequence, not independently per uploaded image. |
| **ST-03** | The boundary between two supplied image segments is **not** automatically a crop boundary. |
| **ST-04** | A single visual scene may continue across an image-segment boundary. If it does, keep it as one crop when the complete visual event belongs together. |
| **ST-05** | A crop may begin in one supplied image and end in another supplied image. This is valid and expected when the visual section crosses the segment boundary. |
| **ST-06** | Do not duplicate, split, or restart crop numbering merely because the source page is divided into multiple uploaded images. Crop IDs follow the combined page's top-to-bottom reading order. |
| **ST-07** | Apply all container, edge, overlay, relevance, no-container, whitespace, and coordinate-independence rules across the combined page exactly as if it were a single source image. |
| **ST-08** | If the stitching boundary visually interrupts a panel or scene, infer the continuous underlying visual section from both adjacent segments rather than treating the interruption as a real panel edge. |
| **ST-09** | When exporting normalized coordinates for a multi-image stitched page, the coordinate system must represent the **combined logical page**. Do not normalize each source segment independently if the crop spans or is positioned relative to the stitched page. |
| **ST-10** | Preserve the original segment order: the first supplied image is the top segment, followed by subsequent images in their given top-to-bottom order, unless the user explicitly indicates a different order. |

### 1.2 Combined-Page Processing

```text
IMAGE 1 (top segment)
        │
        ▼
IMAGE 2 (next segment)
        │
        ▼
IMAGE 3 (next segment)
        │
        ▼
       ...
        │
        ▼
COMBINED LOGICAL MANHWA PAGE
        │
        ▼
Section relevance → container detection → four-edge verification
→ overlay exclusion → no-container fallback → crop assignment
```

**Critical distinction:**

```text
WRONG:
Image 1 → detect crops → stop
Image 2 → detect crops → stop
Image 3 → detect crops → stop

CORRECT:
Image 1
   +
Image 2
   +
Image 3
   ↓
Treat as ONE continuous page
   ↓
Detect all crops in overall top-to-bottom order
```

---

## 2. Glossary

| Term | Definition |
|---|---|
| **Visual section** | A candidate region of the page being considered for a crop. |
| **Container** (= panel, frame, image container) | A visible frame, border, background block, or illustrated block that delimits a scene. The strongest boundary signal available. |
| **Content** (= artwork) | The drawn pixels inside a container. |
| **Subject** | The character, object, or focal element inside the content. |
| **Overlay** | Speech bubble, narration bubble, SFX text/graphic, decorative text, or external text that floats over, beside, above, or below a container. |
| **Metadata** | Manhwa title, chapter title, series name, logo, decorative name tag, branding/title artwork. |
| **Angled edge** | A container boundary that is not parallel to the image axes. |
| **Longer / outer edge** | For an angled boundary, its outermost extent — the position that preserves the whole container inside an axis-aligned rectangle. |
| **Full-width container** | A container whose left and right boundaries coincide with the source image edges (`x = 0.0` and `x = 1.0`). |
| **Breathing room** | Small margin retained so artwork is never clipped. |

**Boundary precedence (memorise this):**

```
container boundary  >  artwork/content boundary  >  subject boundary
```

---

## 3. Core Principles

| ID | Principle |
|---|---|
| **CP-1** | Crop the visual panel/scene — **not** the dialogue surrounding it. |
| **CP-2** | Speech bubbles are **overlays, not boundaries**. They are never crop anchors and must never make a crop larger. |
| **CP-3** | When a container exists, the crop represents the **complete container**, not the artwork inside it. |
| **CP-4** | Every one of the four edges must be **independently verified** — for every crop, every time. |
| **CP-5** | A section must contain a **meaningful subject or story event** to qualify as a crop at all. Visual separation alone is not enough. |

> **Single-sentence summary:**
> If a container exists, capture the complete container with a standard
> rectangular crop; never shorten a container edge to match the artwork,
> never bend the crop to follow an angled edge, and never let an overlay
> expand the crop.

---

## 4. Master Priority Hierarchy

When boundaries or signals conflict, resolve in this order. This list is
**canonical** and replaces all earlier partial hierarchies.

| # | Priority |
|---|---|
| 0 | Combined stitched-page continuity *(when multiple source images form one page)* |
| 1 | Meaningful visual/story section *(gate — evaluated before any boundary work)* |
| 2 | Complete image/container boundary |
| 3 | Independently verified **top** edge |
| 4 | Independently verified **right** edge |
| 5 | Independently verified **bottom** edge |
| 6 | Independently verified **left** edge |
| 7 | Longer/outer edge for angled boundaries |
| 8 | Inferred hidden container edge (edge concealed by an overlay) |
| 9 | Exclusion of speech/narration bubbles, SFX, decorative overlays |
| 10 | Natural visual/fade boundary — only when no container exists |
| 11 | Removal of unnecessary whitespace |
| 12 | Subject/content boundary — **only** when no stronger boundary exists |

---

## 5. Processing Pipeline

```
START
  │
  ▼
[0] If multiple source images form one scrolling page,
    establish their continuous top-to-bottom sequence
  │
  ▼
[1] Identify candidate visual section across the combined page
  │
  ▼
[2] SR gate — meaningful subject or story/visual event?
  │
  ├── NO ─────────────────────────────────▶ SKIP (emit no crop)
  │
  YES
  │
  ▼
[3] Is the section metadata / title / branding?
  │
  ├── YES ────────────────────────────────▶ SKIP (emit no crop)
  │
  NO
  │
  ▼
[4] Does a visual container exist?
  │
  ├── NO ──▶ Find main visual composition
  │          Find natural fade-out boundary
  │          Ignore external overlays
  │          Stop before large empty/unrelated areas
  │          Keep breathing room ─────────────────┐
  │                                              │
  YES                                            │
  │                                              │
  ▼                                              │
[5] Resolve all four container edges             │
    independently:  TOP → RIGHT → BOTTOM → LEFT  │
  │                                              │
  ▼                                              │
[6] Any edge angled?                             │
    YES ▶ use longer/outer edge, keep rectangle   │
  │                                              │
  ▼                                              │
[7] Any edge hidden by an overlay?               │
    YES ▶ infer edge from surrounding geometry    │
  │                                              │
  ▼                                              │
[8] Exclude all overlays                         │
    (bubbles, narration, SFX, decorative text)   │
  │                                              │
  ├──────────────────────────────────────────────┘
  ▼
[9] Preserve complete visual event + necessary context
  │
  ▼
[10] Remove unnecessary whitespace (keep container space)
  │
  ▼
[11] Assign P1 → P2 → P3 → P4  (independently per crop)
  │
  ▼
[12] Run pre-export validation (§15)
  │
  ▼
EXPORT JSON
```

---

## 6. Stage 1 — Section Relevance Gate (`SR`)

This gate runs **before** container-boundary detection. A section that fails
it produces no crop at all.

| ID | Rule |
|---|---|
| **SR-01** | A visual section qualifies as a crop **only** if it contains a meaningful subject or story/visual event. |
| **SR-02** | Gate question: *"Does this section contain a meaningful subject or visual/story event?"* If **no** → skip the section entirely. |
| **SR-03** | Visual separation is **not** qualification. A section may have a clear visual boundary, occupy a large area, and form a distinct visual region — and still be unsuitable for cropping. |
| **SR-04** | **NEVER** create a crop for metadata: manhwa title, chapter title, series name, logo, decorative name tag, or branding/title artwork. This holds even when the title is visually isolated between panels and surrounded by whitespace — it is branding, not a story scene. |
| **SR-05** | **NEVER** create a crop for a background-only section: empty sky, background scenery, foliage, environmental texture, or other background elements with no meaningful subject, character, object, action, or story event. |
| **SR-06** | **NEVER** create a crop for isolated SFX or isolated text with no meaningful visual scene attached. |

### 6.1 Crop-Worthy vs Skip

| ✅ Crop-worthy | ❌ Skip |
|---|---|
| Character, or character interaction | Empty sky |
| Meaningful object or action | Background-only scenery |
| Environmental scene with a meaningful story purpose | Foliage/background with no meaningful subject |
| Complete visual panel containing a meaningful event | Environmental texture |
| Framed illustration containing relevant visual content | Decorative visual space |
| | Whitespace |
| | Metadata / branding / title / name tags |
| | Isolated SFX or text without a visual scene |

```text
Example — SKIP this section:

┌──────────────────────────┐
│                          │
│        EMPTY SKY         │
│      / BACKGROUND        │
│                          │
└──────────────────────────┘
        no subject → no crop


Example — SKIP this title tag:

┌──────────────────────┐
│      CHARACTER       │   ← crop this
└──────────────────────┘

       [WHITE SPACE]

    Wandering Warrior        ← NEVER crop this
        of Wuxia

       [WHITE SPACE]

┌──────────────────────┐
│      NEXT SCENE      │   ← crop this
└──────────────────────┘
```

---

## 7. Stage 2 — Container Detection (`CB`)

| ID | Rule |
|---|---|
| **CB-01** | When a container exists, its boundary is the **strongest** available signal and defines the crop. |
| **CB-02** | Precedence is absolute: `container boundary > artwork/content boundary > subject boundary`. |
| **CB-03** | Crop the **complete container**, not merely the visible artwork inside it. This matters most for small panels embedded in a mostly white page. |
| **CB-04** | If the container is wider or taller than the artwork, use the container's true edges — even where those areas contain little or no artwork. **Do not** crop tighter because the extra container area looks empty. |
| **CB-05** | Do not prematurely crop around the subject. If the character ends earlier than the container, the crop still follows the container. |
| **CB-06** | **Removal test:** *"If I removed all characters, text, bubbles, and overlays, would my four points still match the complete image container?"* If no — the boundary is wrong; correct it. |
| **CB-07** | When multiple visual sections occur on one page, each distinct panel/scene must be segmented independently. Do not merge visually adjacent scenes merely because they share the same page background or overall composition. |

```text
CORRECT — container-complete crop:

┌─────────────────────────┐
│                         │
│      IMAGE CONTENT      │
│                         │
└─────────────────────────┘


INCORRECT — content-only crop:

    ┌───────────────┐
    │ IMAGE CONTENT │
    └───────────────┘
           ↑
    container edges missed
```

---

## 8. Stage 3 — Four-Side Edge Resolution (`ED`)

> Trainings 5, 6, 8, and 9 all failed here. This is the highest-risk stage.

| ID | Rule |
|---|---|
| **ED-01** | Every crop **MUST** independently verify all four edges: top, right, bottom, left. Detecting one or two visible edges is never sufficient. A crop is **not** validated merely because its top and bottom are correct. |
| **ED-02** | **TOP:** the crop must start at the actual container top edge, even when visible artwork begins lower. **Do not** use the top of the character, the top of the visible artwork, the top of a nearby speech bubble, surrounding whitespace, or an assumed visual boundary when a container edge exists above them. |
| **ED-03** | **BOTTOM:** the crop must extend to the actual container bottom edge, even when meaningful artwork appears to end earlier. **Do not** stop at the bottom of the character, the bottom of the visible artwork, the bottom of a speech bubble, or the first apparent fade/whitespace boundary if the container continues below. |
| **ED-04** | **RIGHT:** the crop must reach the true container right edge. Do not shorten it to the visible artwork. A narrow panel is still measured against **its own** complete container. |
| **ED-05** | **LEFT:** the crop must reach the true container left edge, verified independently of the right edge. |
| **ED-06** | Top and bottom receive **exactly the same** scrutiny as left and right. They are the most frequent failure sites. |
| **ED-07** | Never treat a container as correctly detected just because most of its boundary is visible. |

### 8.1 Mandatory Edge-Resolution Procedure

Run this for every candidate container before assigning coordinates.

```text
             TOP
        ┌────────────┐
        │            │
 LEFT   │   IMAGE    │   RIGHT
        │            │
        └────────────┘
            BOTTOM
```

| Step | Action |
|---|---|
| 1 | Identify the complete container — confirm the section has a distinct image/panel boundary. |
| 2 | **Top:** trace the container upward until its actual boundary begins. Do not stop at the first visible artwork. |
| 3 | **Bottom:** trace the container downward until its actual boundary ends. Do not stop at the last visible subject. |
| 4 | **Left:** verify the full horizontal extent of the container. |
| 5 | **Right:** verify the full horizontal extent of the container. |
| 6 | **Angled check:** apply the `AN` rules (§9) to any non-right-angle edge. |
| 7 | **Overlay check:** apply the `OV` rules (§10); exclude bubbles, narration, SFX, decorative overlays and external text. |
| 8 | **Final test:** run the removal test `CB-06`. If it fails, return to step 1. |

### 8.2 Small Framed Images — Extra Verification

`ED-08` — Before finalising a crop around a small framed image:

1. Identify the complete image/container boundary.
2. Check the **left** edge.
3. Check the **right** edge.
4. Check the **top** edge.
5. Check the **bottom** edge.
6. Confirm the crop reaches all four **true** boundaries.
7. Only then exclude external speech bubbles, SFX, or unrelated text.

> Never assume the visible artwork ends where the container ends.

---

## 9. Stage 4 — Angled & Irregular Edges (`AN`)

| ID | Rule |
|---|---|
| **AN-01** | A container boundary may not meet the crop direction at a right angle. Expect this. |
| **AN-02** | **NEVER** bend, rotate, or diagonalise the crop to follow an angle. The crop is always a standard axis-aligned rectangle. |
| **AN-03** | Use the **longer/outer** edge of the angled boundary as the rectangle's boundary. Preserve the full container rather than cutting into it. |
| **AN-04** | Accept the small amount of extra empty/container space this produces. It is correct. |
| **AN-05** | `AN-01`–`AN-04` apply to **all four sides** — top, bottom, left, and right alike. |
| **AN-06** | An angled container still requires exact boundary detection: identify the complete container → trace the angled boundary → determine the longer/outer boundary → apply it consistently across the crop. |
| **AN-07** | **NEVER** substitute whitespace, a speech bubble, or the visible subject/content edge for an angled container edge. |

```text
Container with an angled edge:

┌───────────────────────╮
│                        ╲
│       ARTWORK           ╲
│                          ╲
└───────────────────────────╯

CORRECT — rectangular crop on the longer/outer edge:

┌──────────────────────────┐
│                          │
│       ARTWORK            │
│                          │
└──────────────────────────┘
                           ↑
                  longer/outer container edge

INCORRECT — bent/diagonal crop following the angle
INCORRECT — shortened crop cutting into the container
```

---

## 10. Stage 5 — Overlay Exclusion (`OV`)

Overlays = speech bubbles, narration bubbles, SFX text/graphics, decorative
overlays, external text.

| ID | Rule |
|---|---|
| **OV-01** | Overlays are **overlays, not boundaries**. They are **NEVER** crop anchors. |
| **OV-02** | An overlay must **NEVER** cause a crop to become larger. |
| **OV-03** | **Outside the container:** exclude the overlay completely. The crop begins/ends at the container edge. |
| **OV-04** | **Touching or overlapping the container edge:** treat the overlay as an overlay, not part of the crop region. End the crop at the actual container edge **even when the bubble visually extends beyond it**. Do not expand the crop into the bubble. |
| **OV-05** | **Hidden edge:** if an overlay conceals the exact boundary, do **not** guess from the bubble. Identify the container boundary from the artwork immediately beside it, continue that boundary conceptually *behind* the overlay, and place the crop point on the inferred edge. |
| **OV-06** | Inference signals: left side of the panel, right side of the panel, nearby rows, nearby columns, visible continuation of the artwork, matching horizontal/vertical container boundaries. |
| **OV-07** | SFX and decorative graphics outside a container must not expand the crop. |
| **OV-08** | Never include an overlay merely because it touches the panel. |

### 10.1 Vertical-Page Top/Bottom Check

On long vertical pages, bubbles very frequently sit immediately above or below
panels. `OV-09`:

**Before placing the TOP point** — determine whether the first visible
dark/graphic content is:

- a speech bubble, **or**
- the panel artwork.

If it is a bubble outside the panel, move the boundary down to the actual
artwork/container edge.

**Before placing the BOTTOM point** — apply the same distinction. If the
artwork ends and a bubble begins immediately afterwards, **stop the crop
before the bubble**.

### 10.2 Container-Before-Bubble Procedure

`OV-10` — When a bubble touches or overlaps a container:

1. Identify the complete image/container boundary.
2. Determine that boundary independently on all four sides.
3. Treat the speech bubble as an overlay.
4. Exclude the bubble if it extends outside the container.
5. If the bubble hides an edge, infer it from surrounding artwork/container geometry.
6. Never expand the crop to include the bubble.

```text
WRONG — bubble treated as the top boundary:

        ( SPEECH BUBBLE )
    ┌────────────────────────┐   ← crop started at the bubble
    │                        │
    │        ARTWORK         │
    │                        │
    └────────────────────────┘

RIGHT — bubble excluded, crop at the container edge:

        ( SPEECH BUBBLE )        ← excluded

    ┌────────────────────────┐   ← container edge = crop edge
    │        ARTWORK         │
    │                        │
    └────────────────────────┘


OVERLAPPING CASE — infer the edge behind the bubble:

        ┌───────────────┐
        │ SPEECH BUBBLE │
        └───────┬───────┘
    ┌───────────┴────────────┐   ← inferred container edge
    │        ARTWORK         │      (continue the boundary
    │                        │       conceptually behind
    └────────────────────────┘       the bubble)
```

---

## 11. Stage 6 — No-Container Fallback (`NC`)

Applies **only** when no visible container exists.

| ID | Rule |
|---|---|
| **NC-01** | Identify the main visual composition. |
| **NC-02** | Determine where it naturally fades out; use that as the boundary. |
| **NC-03** | Ignore external speech bubbles and all other overlays. |
| **NC-04** | Stop before large empty or unrelated areas. |
| **NC-05** | Preserve enough visual breathing room to avoid cutting the artwork. |
| **NC-06** | For an edgeless/no-container image, center the meaningful subject or character within the crop and preserve the surrounding visual composition needed to understand the scene. |
| **NC-07** | For an edgeless/no-container image, determine the crop boundaries from where the artwork naturally fades out. Do not force page-wide boundaries or arbitrary rectangular limits onto the scene. |
| **NC-08** | For edgeless scenes, the crop should isolate the meaningful visual composition — not the entire surrounding page region. Exclude narration-only, empty, or dark/white transition areas that do not contribute to the scene. |
| **NC-09** | Centering the subject does not mean cropping tightly to the character silhouette. Preserve the surrounding artwork that belongs to the visual composition, then terminate at the natural fade boundary. |
| **NC-10** | An edgeless scene may occupy only part of the page width. Do not assume `x = 0.0 → 1.0`; determine the meaningful composition's horizontal extent independently. |

---

## 12. Stage 7 — Event Completeness & Whitespace (`CX`, `WS`)

### 12.1 Preserve the Complete Visual Event

| ID | Rule |
|---|---|
| **CX-01** | Do **not** crop only the largest character or object. |
| **CX-02** | Keep relationships that form one meaningful event, e.g. `Character A → weapon → Character B` or `Character → food → reaction`. |
| **CX-03** | Preserve necessary visual context. |
| **CX-04** | The crop must answer **"What is happening here?"** — not **"What is the biggest object here?"** |

### 12.2 Whitespace

| ID | Rule |
|---|---|
| **WS-01** | Large white areas **between** visual sections are normally excluded. |
| **WS-02** | Each crop starts and ends at its own visual section boundary. |
| **WS-03** | Remove unnecessary whitespace, but **preserve necessary container space** — empty area *inside* a container belongs to the container (see `CB-04`). |

```text
┌───────────────┐
│    PANEL      │   ← crop 1 ends here
└───────────────┘

      WHITE          ← excluded from both crops

┌───────────────┐
│    PANEL      │   ← crop 2 starts here
└───────────────┘
```

---

## 13. Stage 8 — Per-Crop Coordinate Independence (`IX`)

> Training 8 failed because a single horizontal inset was reused across every
> crop on the page. **All** side edges were wrong as a result.

| ID | Rule |
|---|---|
| **IX-01** | **NEVER** reuse or copy horizontal coordinates from another crop. Left and right boundaries are detected independently for **every** crop. |
| **IX-02** | Do not assume panels share a horizontal inset. Any panel may have a full-width container, a narrower container, a different left edge, a different right edge, an edge aligned with the page boundary, or an edge hidden by an overlay. |
| **IX-03** | **Full-width containers use the full width:** if the container reaches the image's left and right edges, use `x = 0.0` and `x = 1.0`. Never introduce an artificial inset because earlier crops were narrower. |
| **IX-04** | **Narrow containers keep their own edges:** if a panel does not reach full image width, use that panel's actual left/right boundaries. Do not force it to `0.0 → 1.0`, and do not force it to a neighbouring crop's values. |
| **IX-05** | Explicit pre-export question: *"Did I determine this crop's left and right edges from this crop itself?"* If **no** — re-inspect the image. |
| **IX-06** | `IX-05` applies even when the previous crop's edges look identical, several panels appear aligned, the page uses a repeating layout, or the same coordinates would be convenient. **Convenience and repetition are not evidence of a shared container boundary.** |
| **IX-07** | Independence applies to all four sides; left/right simply fail most often. |

### 13.1 Mandatory Horizontal Boundary Audit

Run for **every** crop, before export:

1. Locate the actual **left** visual/container edge.
2. Locate the actual **right** visual/container edge.
3. Compare both edges against the source image boundary.
4. Determine whether the crop is **full-width** or **inset**.
5. Do **not** copy the result from another crop.
6. Check whether bubbles, narration, SFX, or overlays are distorting the apparent side edge.
7. If an overlay hides the edge, infer the underlying container edge from surrounding geometry.
8. Only then assign `P1.x`, `P2.x`, `P3.x`, `P4.x`.

**Internal consistency (within one crop):**

```text
P1.x == P4.x        (left edge)
P2.x == P3.x        (right edge)
P1.y == P2.y        (top edge)
P3.y == P4.y        (bottom edge)
```

Values **must** be independently derived for that crop. Different crops are
allowed — and often expected — to have different X values.

```text
INCORRECT — copied inset across all crops:
    Crop 1 → x = 0.10 … 0.99
    Crop 2 → x = 0.10 … 0.99
    Crop 3 → x = 0.10 … 0.99
    Crop 4 → x = 0.10 … 0.99

CORRECT — each crop measured on its own:
    Crop 1 → x = 0.0  … 1.0    (full-width container)
    Crop 2 → x = 0.0  … 1.0    (full-width container)
    Crop 3 → x = 0.0  … 1.0    (full-width container)
    Crop 4 → x = 0.17 … 0.94   (narrower container)
```

---

## 14. Output Format (`OUT`)

### 14.1 Required Structure

```json
{
  "format": "four-point-crop",
  "version": "1.0",
  "image": {
    "filename": "10003.jpg",
    "width": 117,
    "height": 2048
  },
  "coordinateSystem": "normalized",
  "crops": [
    {
      "id": "crop-01",
      "reason": "top_character_scene",
      "crop": {
        "mode": "rectangle",
        "points": [
          { "id": "P1", "x": 0.11966, "y": 0.02490 },
          { "id": "P2", "x": 0.78632, "y": 0.02490 },
          { "id": "P3", "x": 0.78632, "y": 0.07617 },
          { "id": "P4", "x": 0.11966, "y": 0.07617 }
        ]
      }
    }
  ]
}
```

> `version` is the **JSON format** version (`1.0`) and is independent of this
> document's version.

### 14.2 Schema — Root Object

| Field | Type | Required | Description |
|---|---|---|---|
| `format` | String | Yes | Must be `"four-point-crop"` |
| `version` | String | Yes | JSON format version |
| `image` | Object | Yes | Source image information |
| `coordinateSystem` | String | Yes | Must be `"normalized"` |
| `crops` | Array | Yes | List of detected crop regions |

### 14.3 Schema — `image` Object

| Field | Type | Required | Description |
|---|---|---|---|
| `filename` | String | Yes | Original image filename |
| `width` | Number | Yes | Original image width in pixels |
| `height` | Number | Yes | Original image height in pixels |

### 14.4 Schema — `crop` Object

Each item in `crops` must contain:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | String | Yes | Unique crop identifier, e.g. `"crop-01"` |
| `reason` | String | Yes | Short description of the visual section |
| `crop` | Object | Yes | Crop geometry |

The nested `crop` object must contain:

| Field | Type | Required | Description |
|---|---|---|---|
| `mode` | String | Yes | Must be `"rectangle"` |
| `points` | Array | Yes | Exactly four points, in order |

### 14.5 Points

Every crop contains exactly four points, in this order:

```text
P1 ───────▶ P2
 ▲          │
 │          ▼
P4 ◀─────── P3
```

| Point | Position |
|---|---|
| `P1` | Top-left |
| `P2` | Top-right |
| `P3` | Bottom-right |
| `P4` | Bottom-left |

Each point has the shape:

```json
{ "id": "P1", "x": 0.0, "y": 0.0 }
```

### 14.6 Coordinate Rules

| ID | Rule |
|---|---|
| **OUT-01** | Coordinates are **normalized**: `x = pixelX / imageWidth`, `y = pixelY / imageHeight`. |
| **OUT-02** | `x` must be between `0.0` and `1.0` inclusive. |
| **OUT-03** | `y` must be between `0.0` and `1.0` inclusive. |
| **OUT-04** | **NEVER** emit pixel coordinates in the JSON output. |
| **OUT-05** | Preserve sufficient decimal precision to reproduce the crop accurately. |
| **OUT-06** | `mode` is always `"rectangle"` — no diagonal or irregular geometry (see `AN-02`). |

### 14.7 Reference Output File — Canonical Shape

**This is the exact shape the platform emits and consumes.** Match it
literally: key order, indentation, point expansion, and decimal precision.

```json
{
  "format": "four-point-crop",
  "version": "1.0",
  "image": {
    "filename": "page_001.jpg",
    "width": 246,
    "height": 2048
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
            "y": 0.244140625
          },
          {
            "id": "P2",
            "x": 1.0,
            "y": 0.244140625
          },
          {
            "id": "P3",
            "x": 1.0,
            "y": 0.604980469
          },
          {
            "id": "P4",
            "x": 0.0,
            "y": 0.604980469
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
            "x": 0.06504065,
            "y": 0.6796875
          },
          {
            "id": "P2",
            "x": 0.727642276,
            "y": 0.6796875
          },
          {
            "id": "P3",
            "x": 0.727642276,
            "y": 0.842285156
          },
          {
            "id": "P4",
            "x": 0.06504065,
            "y": 0.842285156
          }
        ]
      }
    }
  ]
}
```

**What this file demonstrates:**

| Observation | Rule |
|---|---|
| `crop-01` is **full-width** — `x = 0.0` and `x = 1.0` exactly | `IX-03` |
| `crop-02` is **inset** — `x = 0.06504065` to `0.727642276`, its own container edges | `IX-04` |
| The two crops have **different** X values in the same file | `IX-01` |
| Coordinates are unrounded exact ratios (`0.244140625` = `500 ÷ 2048`; `0.06504065` = `16 ÷ 246`) | `OUT-10` |
| Crops appear in top-to-bottom page order | `OUT-07` |
| `reason` is descriptive `snake_case` | `OUT-09` |

> **Source note.** This shape is taken from `training_10_crop_points.json`.
> That file also contained a third crop, `full_width_sky_scene`
> (`y = 0.842285156 → 1.0`), which was **rejected on review**: it was a
> background-only sky section with no meaningful subject or story event, and
> is therefore a `SR-05` violation. The corrected output for that page is the
> two-crop file shown above. Use the file above as the reference — do **not**
> reproduce the rejected sky crop. See §17.7.

### 14.8 Output Formatting Conventions

| ID | Rule |
|---|---|
| **OUT-07** | Crops are emitted in **top-to-bottom page order**, sorted by ascending `P1.y`. |
| **OUT-08** | `id` follows `crop-NN` — zero-padded two digits, sequential from `crop-01`, matching page order. Skipped sections consume no ID; numbering stays contiguous. |
| **OUT-09** | `reason` is lowercase `snake_case` describing the section's content, e.g. `full_width_forest_scene`, `framed_hand_scene`, `top_character_scene`. Keep it short and factual. |
| **OUT-10** | Emit the **exact normalized ratio**, up to 9 decimal places, with trailing zeros stripped. Do not round to a coarser grid — `0.244140625`, not `0.2441` or `0.24`. |
| **OUT-11** | Exact bounds are written as `0.0` and `1.0` — never bare `0` or `1`. |
| **OUT-12** | Two vertically adjacent crops **may** share an identical Y boundary where one section ends exactly where the next begins (e.g. `0.842285156` as both a bottom and the next top). This is expected and valid. It is **not** licence to share X values — see `IX-01`. |
| **OUT-13** | A normal output file **mixes** full-width and inset crops. If every crop in a file carries identical X values, treat it as a probable `IX-01` failure and re-inspect before export. |
| **OUT-14** | `image.width` and `image.height` must be the dimensions of the image actually measured. Because coordinates are normalized, the same crop stays valid if the page is later served at a different resolution. |
| **OUT-15** | Serialize pretty-printed with **2-space indentation**. Root key order: `format`, `version`, `image`, `coordinateSystem`, `crops`. Point key order: `id`, `x`, `y`. Each point object is expanded across multiple lines as shown in §14.7. |
| **OUT-16** | A page with no qualifying section emits a valid file with an **empty** `crops` array — never a placeholder or filler crop. |

### 14.9 Secondary Example — Partial-Width Top Crop

```json
{
  "format": "four-point-crop",
  "version": "1.0",
  "image": {
    "filename": "10002.jpg",
    "width": 117,
    "height": 2048
  },
  "coordinateSystem": "normalized",
  "crops": [
    {
      "id": "crop-01",
      "reason": "top_scene",
      "crop": {
        "mode": "rectangle",
        "points": [
          { "id": "P1", "x": 0.0,      "y": 0.019531 },
          { "id": "P2", "x": 0.991453, "y": 0.019531 },
          { "id": "P3", "x": 0.991453, "y": 0.161621 },
          { "id": "P4", "x": 0.0,      "y": 0.161621 }
        ]
      }
    },
    {
      "id": "crop-02",
      "reason": "framed_character_panel",
      "crop": {
        "mode": "rectangle",
        "points": [
          { "id": "P1", "x": 0.17094,  "y": 0.262207 },
          { "id": "P2", "x": 0.940171, "y": 0.262207 },
          { "id": "P3", "x": 0.940171, "y": 0.337891 },
          { "id": "P4", "x": 0.17094,  "y": 0.337891 }
        ]
      }
    }
  ]
}
```

> Condensed here for readability only — real output uses the expanded point
> form of §14.7 (`OUT-15`). Note `crop-01` reaches `x = 0.991453` rather than
> `1.0`: its container stops just short of the page edge, so it is **not**
> full-width and must not be snapped to `1.0` (`IX-04`).

---

## 15. Pre-Export Validation Checklist (`VAL`)

**No crop is finished until every check below passes.**

### A-0. Multi-Image Stitching
- [ ] If multiple source images were supplied, were they treated as one continuous top-to-bottom page?
- [ ] Was the boundary between supplied images ignored as an automatic crop boundary?
- [ ] Was any scene that crosses an image boundary evaluated as one continuous visual section?
- [ ] Are crop IDs sequential across the combined page rather than restarting per image?
- [ ] If a crop crosses source-image boundaries, is its geometry based on the combined logical page?

### A. Scene relevance
- [ ] Is this a meaningful story/visual section?
- [ ] Is it artwork rather than metadata/branding?
- [ ] Does it contain a subject, object, action, or story event — not just background?

### B. Exclusion check
- [ ] Is the section a manhwa title, series name, logo, or name tag? → **do not crop it**
- [ ] Is the section background-only (sky, scenery, foliage, texture)? → **do not crop it**
- [ ] Is the section isolated SFX/text with no visual scene? → **do not crop it**

### C. Container verification *(if a container exists)*
- [ ] Have all four container edges been identified independently?
- [ ] Does the crop reach the true **top** edge?
- [ ] Does the crop reach the true **right** edge?
- [ ] Does the crop reach the true **bottom** edge?
- [ ] Does the crop reach the true **left** edge?
- [ ] Is the crop following the **container**, not the artwork inside it?

### D. Angled-edge check
- [ ] If any edge is angled, was the **longer/outer** edge used?
- [ ] Is the crop still a standard rectangle — not bent, rotated, or diagonal?
- [ ] Was the container preserved rather than cut into?

### E. Overlay exclusion
- [ ] Are speech bubbles outside the container excluded?
- [ ] Are speech bubbles overlapping the container excluded (crop not expanded)?
- [ ] Are narration bubbles excluded?
- [ ] Are external sound effects excluded?
- [ ] Are decorative overlays excluded?
- [ ] Where an overlay hides an edge, was the underlying edge inferred from surrounding geometry?
- [ ] Was no edge moved outward to accommodate an overlay?

### F. Content & whitespace
- [ ] Is the complete visual event preserved (not just the largest object)?
- [ ] Is necessary visual context retained?
- [ ] Is unnecessary whitespace removed?
- [ ] Is necessary container space preserved?

### G. Coordinate independence
- [ ] Were this crop's left and right edges determined from **this crop itself**?
- [ ] Was the full-width vs inset decision made per crop (`x = 0.0 / 1.0` only where truly full-width)?
- [ ] Were no coordinates copied from a neighbouring crop?

### H. Geometry
- [ ] Exactly four points?
- [ ] Order is `P1 → P2 → P3 → P4`?
- [ ] `P1.x == P4.x`, `P2.x == P3.x`, `P1.y == P2.y`, `P3.y == P4.y`?
- [ ] Coordinates normalized, all within `0.0`–`1.0`?
- [ ] No edge unintentionally clipped?

### I. JSON integrity
- [ ] JSON is syntactically valid.
- [ ] `format` is `"four-point-crop"`.
- [ ] `coordinateSystem` is `"normalized"`.
- [ ] `mode` is `"rectangle"`.
- [ ] Every crop has `id`, `reason`, and `crop`.
- [ ] `image.width` and `image.height` match the image actually measured.
- [ ] No pixel coordinates present anywhere in the output.
- [ ] Final JSON parsed once before delivering the file.

### I-2. Output conventions *(match §14.7 exactly)*
- [ ] Crops sorted top-to-bottom by ascending `P1.y`?
- [ ] `id` values sequential and zero-padded — `crop-01`, `crop-02`, … with no gaps?
- [ ] Every `reason` present, lowercase `snake_case`, and descriptive?
- [ ] Coordinates emitted at exact ratio precision (up to 9 dp), not rounded to a coarse grid?
- [ ] Exact bounds written as `0.0` / `1.0`, never bare `0` / `1`?
- [ ] Key order and 2-space indentation match the reference file?
- [ ] Points expanded across multiple lines, keys in `id`, `x`, `y` order?
- [ ] Does the file mix full-width and inset crops as the page actually requires — and if every crop shares identical X values, was that re-verified as genuine rather than copied?
- [ ] If no section qualified, is `crops` an empty array rather than a filler crop?

### J. Final removal test
- [ ] *"If I removed all characters, text, bubbles, and overlays, would my four
      points still match the complete image container?"* → must be **yes**.

---

## 16. Worked Examples

### 16.1 Action Panel — Exclude Both Bubbles

```text
INPUT:
        ( SPEECH BUBBLE )          ← overlay, excluded

    ┌────────────────────────┐     ← true top panel edge
    │      ACTION            │
    │   CHARACTER  ✦         │
    │               IMPACT   │
    └────────────────────────┘     ← true bottom panel edge

            【 NO! 】               ← overlay, excluded

CROP:
    ┌────────────────────────┐
    │      ACTION            │
    │   CHARACTER  ✦         │
    │               IMPACT   │
    └────────────────────────┘
```

Applies `OV-03`, `OV-09`, `CX-02`.

### 16.2 Character Panel — Bubbles Above and Below

```text
INPUT:
      ( dialogue bubble )          ← excluded

    ┌────────────────────────┐
    │                        │
    │       CHARACTER        │
    │                        │
    └────────────────────────┘

      ( dialogue bubble )          ← excluded

CROP: exactly the artwork panel, neither bubble included.
```

Applies `OV-03`, `OV-09`.

### 16.3 Container Edge vs Subject Edge

```text
┌────────────────────────┐   ← crop follows THIS
│     CHARACTER          │
│                        │
│               object   │
└────────────────────────┘

Even though the character ends well before the container's right and
bottom edges, the crop follows the container.
```

Applies `CB-02`, `CB-04`, `CB-05`.

### 16.4 SFX Outside a Container

```text
INPUT:
    ┌──────────────────────┐
    │        IMAGE         │
    │                      │
    └──────────────────────┘
                     【SFX】   ← excluded

CROP:
    ┌──────────────────────┐
    │        IMAGE         │
    │                      │
    └──────────────────────┘
```

Applies `OV-07`.

---

## 17. Training Review Log

Historical evidence for the rules above. Useful for regression testing; not
itself normative.

### 17.1 Page `10002.jpg`

| Crop | Result | Note |
|---|---|---|
| 1 | Correct | — |
| 2 | Correct | — |
| 3 | Corrected | Artwork panel only; top/bottom tightened; bubbles excluded |
| 4 | Corrected | Artwork panel only; top/bottom tightened; bubbles above and below excluded |
| 5 | Correct | — |
| 6 | Correct | — |

### 17.2 Training 4 — `10004.jpg`

| Crop | Result | Learned rule |
|---|---|---|
| 1 | Correct | Preserve |
| 2 | Correct | Preserve |
| 3 | Correct | Preserve |
| Title-tag crop | **Incorrect** | `SR-04` — never crop manhwa name/title tags |
| Food / image-container crop | Corrected | `CB-03`, `ED-04` — follow complete container edges, especially right and bottom |
| Character conversation | Correct | Preserve |
| Side-profile scene | Correct | Preserve |
| Final scene | Correct | Preserve |

The food/image-container crop needed repeated correction because the initial
crops kept missing the **right and bottom** container edges. The accepted crop
followed the container boundary, not the smaller visible content area.

### 17.3 Training 5 — `10005.jpg`

| Crop | Result | Learned rule |
|---|---|---|
| 1–3 | Correct | Preserve |
| 4 | **Incorrect → corrected** | `ED-02` — must include the true **top** container edge; the crop started below it |
| 5 | **Incorrect → corrected** | `ED-03`, `ED-04`, `AN-03` — must include true bottom/right container edges; angled edges use the longer edge without bending the crop |
| 6 | Correct | Preserve |

Confirms: container edges must be checked independently on all four sides; the
top edge must not be missed; bottom and right must not be shortened; angled
boundaries must not bend the rectangle; use the longer/outer edge.

### 17.4 Training 6 — `10006.jpg`

| Crop | Result | Learned rule |
|---|---|---|
| 1 | Correct | Preserve |
| 2 | **Incorrect → corrected after repeated review** | `ED-02` — must reach the true top container edge |
| 3 | **Incorrect → corrected after repeated review** | `ED-03` — must reach the true bottom container edge |
| 4–6 | Correct | Preserve |

Accepted after correcting only Crops 2 and 3. Reinforces `ED-01`: repeated
single-side misses mean each side needs its own independent check.

### 17.5 Training 8 — `10008.jpg`

Initial result used an approximately common horizontal inset for **all** crops.
Review finding: **all crop side edges were missed.**

| Crop | Corrected side geometry |
|---|---|
| 1 | Full-width |
| 2 | Full-width |
| 3 | Full-width |
| 4 | Its own narrower left/right container boundaries |
| 5 | Full-width |
| 6 | Full-width |

> The lesson is not the specific coordinates — it is `IX-01`: **every crop must
> independently determine its own left and right boundaries.**

**Crop 5, second correction:** the crop did not begin/end at the true image
container boundary, and it also included a speech/text bubble extending outside
the container. Corrected by identifying the complete visual container first
(the blue illustrated scene) and cropping exactly to it, with the bubble
excluded. See `OV-10`, `CB-01`.

Crop 5 final validation required:
- top edge = true container top;
- bottom edge = true container bottom;
- left edge = true container left;
- right edge = true container right;
- external speech/text bubble excluded;
- no edge moved outward to accommodate the bubble.

### 17.6 Training 9 — `10009.jpg`

| Crop | Result | Learned rule |
|---|---|---|
| 1–2 | Correct | Preserve |
| 3 | **Incorrect** | `ED-04` — right edge must reach the complete container boundary. Initial `x ≈ 90/154`; accepted `x ≈ 116/154`. A narrower panel is still measured against its own complete container. |
| 4 | **Incorrect** | `ED-02` + `AN-03` — the panel is an angled container whose top begins substantially lower than the coordinate first chosen. Accepted top ≈ `y = 1138/2048`, using the outer/topmost boundary of the angled container. Surrounding whitespace and the speech bubble must not be used as the top boundary. |
| 5 | Correct | Preserve |

### 17.7 Training 10 — `page_001.jpg` (246 × 2048)

Emitted output: `training_10_crop_points.json`.

| Crop | `reason` | Y range | Result | Learned rule |
|---|---|---|---|---|
| 1 | `full_width_forest_scene` | `0.244140625 → 0.604980469` | Correct | Preserve |
| 2 | `framed_hand_scene` | `0.6796875 → 0.842285156` | Correct | Preserve complete framed container |
| 3 | `full_width_sky_scene` | `0.842285156 → 1.0` | **Rejected** | `SR-05` — background/sky section with no meaningful subject or story event |

Confirmed: Crop 3 must be skipped because it had no subject; Crops 1 and 2
accepted as correct. The accepted two-crop result is the canonical output
shape reference in §14.7.

**Structural lessons carried forward from this file:**

- Crop 1 is full-width (`0.0 → 1.0`) while Crop 2 is inset
  (`0.06504065 → 0.727642276`) — correct per-crop side detection (`IX-01`).
- Crop 2's bottom and Crop 3's top share `0.842285156`; adjacent sections
  legitimately abut (`OUT-12`).
- Reaching the page bottom (`y = 1.0`) is not evidence that a section
  qualifies — Crop 3 did, and was still rejected (`SR-03`).

---

## 18. Quick Rule Index

| ID | One-line summary |
|---|---|
| **ST-01** | Consecutive segments of one page are treated as a single stitched page |
| **ST-02** | Sections are determined on the combined top-to-bottom sequence |
| **ST-03** | A segment boundary is never automatically a crop boundary |
| **ST-04** | A scene continuing across a segment stays one crop |
| **ST-05** | A crop may start in one image and end in another |
| **ST-06** | Never split or restart numbering because of segmentation |
| **ST-07** | All other rules apply across the combined page |
| **ST-08** | Infer the underlying section through a stitch interruption |
| **ST-09** | Normalize against the combined logical page |
| **ST-10** | Preserve the supplied segment order |
| **CP-1** | Crop the panel/scene, not the surrounding dialogue |
| **CP-2** | Bubbles are overlays, never boundaries |
| **CP-3** | Crop the complete container, not the artwork inside |
| **CP-4** | Verify all four edges independently, every time |
| **CP-5** | No meaningful subject/event → no crop |
| **SR-01** | Crop only sections with a meaningful subject or story event |
| **SR-02** | Relevance gate runs before boundary detection |
| **SR-03** | Visual separation alone does not qualify a section |
| **SR-04** | Never crop titles, series names, logos, name tags, branding |
| **SR-05** | Never crop background-only sections (sky, scenery, foliage, texture) |
| **SR-06** | Never crop isolated SFX/text with no visual scene |
| **CB-01** | Container boundary is the strongest signal |
| **CB-02** | Container > content > subject |
| **CB-03** | Capture the complete container, not just visible artwork |
| **CB-04** | Include container area that looks empty |
| **CB-05** | Do not crop tight to the subject when a container exists |
| **CB-06** | Removal test — points must match the container with all content stripped |
| **CB-07** | Distinct visual sections on one page are segmented independently; do not merge adjacent scenes |
| **ED-01** | All four edges verified independently for every crop |
| **ED-02** | Top edge = true container top, never the artwork/bubble/whitespace top |
| **ED-03** | Bottom edge = true container bottom, never the first fade or bubble |
| **ED-04** | Right edge = true container right, never the visible artwork edge |
| **ED-05** | Left edge = true container left, verified on its own |
| **ED-06** | Top/bottom get the same scrutiny as left/right |
| **ED-07** | Mostly-visible boundary ≠ correctly detected container |
| **ED-08** | Small framed images need explicit four-side verification first |
| **AN-01** | Expect non-right-angle container boundaries |
| **AN-02** | Never bend, rotate, or diagonalise the crop |
| **AN-03** | Use the longer/outer edge of an angled boundary |
| **AN-04** | Extra empty container space from an angled edge is correct |
| **AN-05** | Angled rules apply to all four sides |
| **AN-06** | Angled containers still require exact boundary detection |
| **AN-07** | Never substitute whitespace/bubble/subject for an angled edge |
| **OV-01** | Overlays are never crop anchors |
| **OV-02** | An overlay must never enlarge a crop |
| **OV-03** | Overlay outside the container → exclude completely |
| **OV-04** | Overlay overlapping the edge → still end at the container edge |
| **OV-05** | Overlay hiding an edge → infer the edge, never guess from the bubble |
| **OV-06** | Inference signals: adjacent sides, nearby rows/columns, artwork continuation |
| **OV-07** | External SFX must not expand the crop |
| **OV-08** | Touching the panel is not a reason to include an overlay |
| **OV-09** | Check bubble-vs-artwork before placing the top and bottom points |
| **OV-10** | Container-before-bubble six-step procedure |
| **NC-01** | No container → identify the main visual composition |
| **NC-02** | Use the natural fade-out boundary |
| **NC-03** | Ignore external bubbles |
| **NC-04** | Stop before large empty/unrelated areas |
| **NC-05** | Keep breathing room so artwork is not clipped |
| **NC-06** | Edgeless image → center the meaningful subject and preserve necessary composition |
| **NC-07** | Edgeless image → use the natural artwork fade as the boundary; do not force page-wide limits |
| **NC-08** | Edgeless crop isolates the meaningful composition, excluding narration/empty transition areas |
| **NC-09** | Center the subject without cropping tightly to its silhouette; preserve surrounding composition |
| **NC-10** | Edgeless scenes may be partial-width; determine horizontal extent independently |
| **CX-01** | Do not crop only the largest object |
| **CX-02** | Keep relationships forming one event |
| **CX-03** | Preserve necessary visual context |
| **CX-04** | Answer "what is happening", not "what is biggest" |
| **WS-01** | Exclude large whitespace between sections |
| **WS-02** | Start/end each crop at its own section boundary |
| **WS-03** | Remove unnecessary whitespace, keep necessary container space |
| **IX-01** | Never copy horizontal coordinates between crops |
| **IX-02** | Panels do not share a horizontal inset |
| **IX-03** | Full-width containers use `x = 0.0` and `x = 1.0` |
| **IX-04** | Narrow containers keep their own side edges |
| **IX-05** | Ask: were these side edges derived from this crop itself? |
| **IX-06** | Convenience and repetition are not evidence |
| **IX-07** | Independence applies to all four sides |
| **OUT-01** | Normalized coordinates: pixel ÷ dimension |
| **OUT-02** | `x` within `0.0`–`1.0` |
| **OUT-03** | `y` within `0.0`–`1.0` |
| **OUT-04** | Never emit pixel coordinates |
| **OUT-05** | Keep enough decimal precision to reproduce the crop |
| **OUT-06** | `mode` is always `"rectangle"` |
| **OUT-07** | Crops ordered top-to-bottom by ascending `P1.y` |
| **OUT-08** | `id` is `crop-NN`, zero-padded, sequential, contiguous |
| **OUT-09** | `reason` is descriptive lowercase `snake_case` |
| **OUT-10** | Exact ratio precision, up to 9 dp, no coarse rounding |
| **OUT-11** | Write exact bounds as `0.0` / `1.0`, never `0` / `1` |
| **OUT-12** | Adjacent crops may share a Y boundary — but never X values |
| **OUT-13** | Identical X across all crops is a probable `IX-01` failure |
| **OUT-14** | `image.width`/`height` = dimensions actually measured |
| **OUT-15** | 2-space indent, fixed key order, expanded point objects |
| **OUT-16** | No qualifying section → empty `crops` array, never filler |

---

## 19. Final Statement

> **When multiple source images form one scrolling manhwa page, treat them as
> one continuous top-to-bottom page before detecting crops; a source-image
> boundary is never automatically a crop boundary. When a container exists,
> the crop represents the container — not the artwork inside it. Every one of
> the four edges must be independently verified, with the top and bottom
> receiving the same attention as the left and right. If an edge is angled,
> keep the crop rectangular and use the longer/outer edge. If an edge is
> hidden, infer it from surrounding geometry. Overlays never expand a crop.
> Horizontal coordinates are never copied between crops. When no container
> exists, isolate the meaningful visual composition, center the subject
> appropriately without cropping to its silhouette, exclude narration/empty
> transition areas, and use the natural image fade as the crop boundary.
> Distinct adjacent scenes remain separate crops, even across stitched image
> segments. And a section without a meaningful subject or story event is never
> cropped at all.**
