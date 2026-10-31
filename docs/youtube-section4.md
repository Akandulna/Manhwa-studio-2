# YouTube section 4: references and manual thumbnails

Studio's Thumbnail tab now supports crop references, three independent ChatGPT image prompts per batch, image importing, persistent selection, copying/downloading, and feedback-based edits or fresh concepts. The series workspace remains English and shared across all parts. Sleeper-Cell automation is the next section.

## User flow

1. Choose a title, then open Thumbnail and browse chapter crops. Select 1–10 images across chapters; choose the primary character reference. Selections save immediately. Crops are read without modifying source outputs.
2. Create thumbnail prompts. Download and unzip the prompt/reference pack. It contains three prompt TXT files, numbered PNG references, instructions, and a base thumbnail when editing. Attach the extracted images to ChatGPT with each prompt. Each prompt asks for one actual image; the batch represents three separate alternatives.
3. Import the generated PNG, JPEG or WebP into its matching variation slot. Imports do not automatically replace the selected thumbnail. Choose a preferred variation; copy its actual PNG image to the clipboard or download it. Clipboard access depends on the browser; download remains available. Non-16:9 imports are preserved with a review hint when selected.
4. Refine an existing thumbnail with feedback, or request a fresh concept. Edits include the parent image; fresh concepts include crop references alone. Both create a new three-slot request and retain every earlier image and prompt. Open requests resumes unfinished batches.

## Persistence and contracts

State lives under `server/.config/youtube/` with the other YouTube work: workspace JSON plus immutable content-addressed PNGs scoped to the series. Reference bytes are copied on selection, normalized from supported still-image formats, and checked by SHA-256 when served. Request snapshots retain their own reference identities, full prompts, current guideline version/hash, and internal master-prompt hash. Removing a current reference does not break earlier requests. The existing internal master remains in resources and is adapted at prompt generation; it is not exposed as a Settings document.

Images are limited to 20 MB and 40 megapixels; animated inputs, SVG and corrupt images are rejected. Imports are decoded to PNG, retain actual dimensions, and never fabricate a successful generation. Each request has three import slots; populated slots cannot be overwritten. Make another request to retain history. Changing the title preserves existing images and selection, flags mismatches, and blocks imports against old-title requests. All thumbnail mutations use the shared workspace revision for conflict protection. Reload recovers current server state without clearing revision-feedback drafts stored in sessionStorage.

Crop APIs scope chapter IDs to their selected series, exclude archived chapters, and never accept filesystem paths. Managed chapters use the existing reviewed immutable managed-asset inventory and reader, without falling back to legacy outputs for incomplete managed work. Legacy chapters read their existing crops3 outputs; changed file timestamps/sizes invalidate crop IDs. Resolved legacy files must remain inside that chapter's crop directory. Private image APIs and download packs resolve image IDs only through the chosen series workspace.

No direct AI API, phone dispatch, actual YouTube upload, or Hinglish behavior is introduced. Studio prepares requests; the user generates in ChatGPT and imports the actual image files.

## Validation

47 focused YouTube storage, parser, HTTP and image tests; server TypeScript; client TypeScript and production web bundle. Isolated Chromium checks with synthetic fixtures cover ten-reference enforcement, prompt and image clipboard copying, ZIP download, multiple imports, selection, feedback edits, fresh batches, request history, reload persistence, and constrained dialog layouts. User series data and connected phones are not used by these checks.
