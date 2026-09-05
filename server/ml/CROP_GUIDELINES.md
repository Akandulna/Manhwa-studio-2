# Image Cropping Guidelines

Guidelines for cropping a manhwa chapter's pages into ordered "section" images
(Module 3 — Image Clipper). These crops are the visual units that later feed the
Video Editor (Module 4), where each crop is fitted to a 16:9 frame, placed over a
blurred background, and given slow drift/zoom while narration audio plays.

> **Goal of a crop:** one clean, self-contained *story beat* — a character moment
> or a scenery shot — with as little distracting overlay as possible, so it reads
> well as a moving image under spoken narration.

---

## 1. Scope — what becomes a crop

**Include**
- Sections that show a **character** (full body, close-up, reaction, chibi/comedic, group) — and **chibi/comedy panels count**.
- Sections that show **scenery, setting, or a meaningful object/illustration** (e.g. an in-world book cover, a dish of food, an establishing shot).

**Exclude**
- **Intro and outro** of the chapter (translator/site promo banners, credits, "read at …" pages).
- **Text-only areas** — a panel that is *just* a narration box or dialogue over a blank/plain background carries no image value; skip it.
- **Abstract-only areas** — pure decorative transitions, gradient/pattern fills, blood-splatter or speed-line fields with no subject. (If a *framed subject* sits inside an abstract field, crop the framed subject and leave the abstraction out.)

---

## 2. Setting the crop boundary

The boundary rule depends on what the original art gives you:

| Situation | Rule |
|-----------|------|
| **Defined border** (clear panel edge / frame) | Snap the crop to that border — use it as the edge reference. |
| **No border** (full-bleed art, subject floats on background) | Center the character / action; add **padding on the sides, mostly top & bottom**. |
| **Partial border** (one side framed, the other fades out) | Crop the framed side to its edge; on the open side, cut **just past where the art fades**, with a little padding. *(See the two reference images: 1st = the resulting crop, 2nd = the full surrounding context it was taken from.)* |

Follow the panel's actual geometry — **diagonal/slanted borders are cropped along the slant**, not forced to a rectangle.

---

## 3. Text, bubbles, SFX & watermarks

**"Exclude text" is not absolute.** Do not treat every glyph as something to remove.
The test is whether the text is a *separable overlay* sitting on top of the art, or
*part of the artwork itself*:

- **Exclude — separable overlay:** narration/caption boxes and dialogue speech bubbles. Frame the crop to leave them out.
- **Acceptable at edges:** a small sliver of a bubble or box clipping the edge is fine if avoiding it would harm the composition.
- **Keep — part of the art:** stylized **sound effects / onomatopoeia** (e.g. 짝, 쿵, 꿀꺽) and **in-world text** (a book/title rendered as part of the illustration). These are visual elements, not overlay.
- **Unavoidable text in valuable action art:** if text is fused into a dynamic illustration and can't be removed without destroying the scene, the crop is still acceptable — but frame to **minimize** the text where possible.
- **Consistency rule:** apply one policy to prominent exclamation bubbles (e.g. "WHEW!"). Default: **exclude** dialogue/exclamation bubbles unless they are drawn as SFX-style art.

### Watermarks — auto-detected and white-filled (Watermark Lab)

Site watermarks (e.g. `luacomic.org`) are **not** a reason to move or shrink an
otherwise good crop. Crop the section normally, ignoring the watermark's position —
the export pipeline removes it for you by painting a solid white fill over it.

This is automated per series via the **Watermark Lab** (sidebar → Image Clipper →
Watermark Lab):

1. **Identify the watermark once per series.** Pick the series + a chapter where the
   watermark is visible, then **drag a box over it** to save it as a template.
   A series can have several templates (e.g. a dark badge variant and a light text
   variant); add one for each form the watermark takes.
2. **Tune if needed.** Each template has a match-threshold slider (lower = catch more,
   risk false hits; higher = stricter) and an enable/disable toggle. Use
   **Detection preview** to see, in red, exactly what would be white-filled on a
   chapter before exporting.
3. **Export as usual.** On finalize, every enabled template is matched across all of
   the chapter's pages (OpenCV) and each hit that falls inside a crop is white-filled
   automatically. No per-crop work, and no need to frame around the watermark.

Manual fallback / notes:
- If the OpenCV sidecar is unavailable or a series has no templates, export still runs —
  it just skips white-fill (the Lab warns when the sidecar is missing).
- The fill is **solid white**, so a watermark sitting over dark artwork leaves a white
  patch. If that patch would land on the main subject, prefer re-framing the crop to
  keep the watermark out instead.

---

## 4. Subject & composition

**Rule — never cut through a face or body awkwardly.**
A crop boundary must **not** pass through a character's face/eyes, and must **not**
chop a body at an unnatural point (mid-neck, mid-joint, mid-hand). Either include
the whole feature/figure, or — for a deliberate extreme close-up — frame *inside*
it cleanly (e.g. a tight eye shot) rather than slicing across it. If a panel border
already cuts the figure, keep the crop on the art side of that border.

**Rule — dead space.**
Distinguish **intentional padding** from **dead space**:
- *Padding* (keep): breathing room added on purpose — to center a subject, respect a fade, or give headroom. Good.
- *Dead space* (remove): large empty/blank regions that carry no subject and no compositional purpose. Tighten the crop to cut them out.

Also:
- **Give headroom / breathing space** around the main subject; let the action sit comfortably in frame.
- **Keep the beat legible** — the crop should still make sense on its own; don't crop so tight that the scene loses its meaning or context.

---

## 5. Sizing & aspect (for the video pipeline)

- **Preserve source resolution** — don't crop so tight that the image must be heavily upscaled later (it will blur under zoom).
- **Aspect follows content** — tall vertical for full-body/standing shots, near-square for establishing/scenery, wide for eye/hand/object close-ups. All are fine.
- **Avoid extreme slivers** — a very thin tall/wide crop produces large blurred side-bars and weak motion in the 16:9 frame. If a moment needs a sliver, accept it, but prefer a fuller frame when the art allows.

---

## 6. Ordering & granularity

**Rule — granularity (one beat per crop).**
- **One story beat = one crop.** Don't merge two distinct moments into a single crop.
- **One panel per crop** is the default. Combine adjacent panels into one crop **only** when they read as a single continuous moment.
- **No bleed-in** — don't leave a slice of the *next* (or previous) panel hanging at the edge of a crop.
- **Spanning illustrations** — when one tall illustration is split across multiple page files, crop the whole illustration as a **single** beat, not one crop per file.
- **Story order, top-to-bottom.** Crops are numbered in reading order; keep them sequential.

**Rule — duplicates (defined by region overlap).**
Two crops are duplicates **only if their cropped regions overlap the same area of
the page.** Visual similarity alone does not make a duplicate.
- **Overlapping regions** → that's a duplicate; keep one (the better-framed) and remove the other.
- **Non-overlapping regions** → **not** duplicates, even if the two images look alike (e.g. the same pose appearing in separate panels). Keep both.

---

## 7. Quick checklist

Before saving a crop, confirm:

- [ ] It's a **character or scenery/object** beat (not intro/outro, not text-only, not pure abstract).
- [ ] Boundary follows the rule for its border type (**defined / none / partial-fade**).
- [ ] **Narration boxes & dialogue bubbles** are framed out (small edge slivers OK); **SFX / in-world art text** may stay.
- [ ] **Watermark** — a template exists for this series in Watermark Lab so it's auto-white-filled on export (only re-frame if the fill would hit the subject).
- [ ] Subject isn't severed through a face/body; it has headroom and stays legible.
- [ ] Padding is intentional; no large dead space; not an extreme sliver.
- [ ] Source resolution preserved; aspect suits the content.
- [ ] It is a **single beat**, in story order, with no bleed-in; not a region-overlap duplicate.

---

## 8. Decision flow

```
Is the section intro/outro, text-only, or pure abstract?
        │ yes → SKIP
        │ no
        ▼
Does it show a character or scenery/object?  ── no ─→ SKIP
        │ yes
        ▼
What border does the art give?
   ├─ Defined border      → snap crop to the edge (follow slant if diagonal)
   ├─ No border           → center subject, pad top/bottom (+ sides)
   └─ Partial / fades out  → frame the bordered side; cut just past the fade + small padding
        ▼
Frame out narration boxes & dialogue bubbles
   (keep SFX / in-world text; edge slivers acceptable)
        ▼
White-fill any watermark in the crop (don't re-frame unless it covers the subject)
        ▼
Check: face/body not severed · legible · intentional padding · no sliver
       · full resolution · single beat · not a region-overlap duplicate
        ▼
SAVE  (numbered in story order)
```