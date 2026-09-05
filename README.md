# Manhwa Studio

A local full-stack desktop-style web app for managing and downloading manhwa series, with AI-powered narration script generation.

![Manhwa Studio](https://img.shields.io/badge/Module%201-Library%20%26%20Downloader-purple)
![Manhwa Studio](https://img.shields.io/badge/Module%202-Narration%20Studio-blue)

## Features

### Module 1: Library & Downloader
- **URL Pattern Detection**: Paste 3 seed URLs and automatically detect the chapter numbering pattern
- **Auto Chapter Discovery**: Automatically find all available chapters by validating URLs
- **Concurrent Downloads**: Download multiple chapters simultaneously with configurable concurrency
- **Image Detection**: Smart detection of manhwa page images using Playwright headless browser
- **Progress Tracking**: Real-time progress updates via WebSocket
- **Resume Support**: Skip already downloaded pages, retry failed downloads
- **Organized Storage**: Clean folder structure with zero-padded chapter numbers

### Module 2: Narration Studio
- **AI Script Generation**: Generate YouTube-style recap narration scripts from manhwa images
- **Story Continuity**: Automatic rolling summaries and chapter seams for seamless multi-chapter narratives
- **Part Management**: Group chapters into "Parts" for video production, with auto-generated outros
- **Dual Mode**: API mode (Gemini AI) or Manual mode (copy prompt, paste response)
- **Smart Batching**: Handles large chapters (50-150 images) via map-reduce processing
- **Script Editor**: Edit generated scripts with live continuity context
- **Provider Abstraction**: Gemini implemented, easy to add OpenAI/Anthropic later

### Module 3: Image Clipper
- **Crop Workspace**: Draw, move, and resize crops on a virtualized vertical canvas of a chapter's pages
- **Click-to-Add**: Click the page to drop a full-width crop; adjust height/width by dragging edges
- **Story-Order Numbering**: Crops auto-number top-to-bottom; inserting/moving renumbers automatically
- **AI Auto-Crop**: Optional locally-trained model (or rule-based fallback) suggests crops to accept/reject
- **Finalize/Export**: Batch-exports crops to PNG on disk for downstream modules

### Module 4: Video Editor
- **Compile to MP4**: Stitch narration scripts + per-section voiceover audio + cropped images into a 16:9 video, across one or many chapters as a continuous "Part"
- **Audio as Master Clock**: Each script part's audio is never trimmed; selected images subdivide its duration with draggable boundaries (sum always locked to the audio)
- **Per-Image Motion**: Gentle drift (slow zoom/pan) by default, or manual focus mode with an anchor point; plus manual scale/offset overrides; blurred+darkened background behind each foreground image
- **End Title Card**: Auto end card (series title + closing line, editable) over a fixed duration with music continuing underneath
- **Background Music**: Global music library; looped under the narration with master + music volume controls
- **Live + Rendered Preview**: Instant client-side approximate preview, plus a pixel-faithful low-res proxy render
- **AI Assist**: Zero-shot image-range and focus-anchor suggestions (Gemini vision); every edit is logged for a future style model
- **Export**: 1080/720/480p, quality presets, progress + cancel, open output folder

### Coming Soon (Disabled Placeholders)
- Panel Splitter

### Module 2 Part 2: Voiceover
- **TTS Generation**: Convert narration scripts to audio using Gemini TTS
- **Section Management**: Auto-split scripts into voice sections for better control
- **Voice Selection**: Choose from 8 Gemini voices (Aoede, Charon, Fenrir, Kore, Leda, Orus, Puck, Zephyr)
- **Audio Processing**: FFmpeg-based audio normalization, format conversion, and concatenation
- **Audio Upload**: Upload your own voice recordings for sections
- **Voice Analysis**: Analyze voice consistency across sections (optional Python sidecar)
- **Chapter Audio Export**: Join all sections into a single downloadable MP3

## Tech Stack

- **Frontend**: React + Vite + TypeScript + Tailwind CSS + shadcn/ui
- **Backend**: Node.js + Express + TypeScript
- **Database**: SQLite via Prisma
- **Scraping**: Playwright (headless Chromium)
- **Real-time**: Socket.io (WebSocket)
- **Download Queue**: p-queue
- **AI**: Google Gemini via @google/generative-ai
- **Image Processing**: sharp
- **TTS**: Gemini TTS (gemini-2.5-flash-preview-tts)
- **Audio Processing**: FFmpeg

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm or yarn
- FFmpeg (required for Voiceover)
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - Windows: Download from https://ffmpeg.org/download.html

## Setup Instructions

### 1. Clone and Install Dependencies

```bash
cd "Manhwa studio 2"

# Install all dependencies (root, server, and client)
npm install
```

### 2. Install Playwright Chromium

This is required for scraping JavaScript-rendered pages:

```bash
npx playwright install chromium
```

### 3. Configure Environment

Copy the example environment file:

```bash
cp .env.example server/.env
```

Edit `server/.env` if needed:

```env
# Root folder for all downloaded manhwa
DOWNLOAD_ROOT=./downloads

# Maximum concurrent downloads (1-10)
CONCURRENCY=3

# Delay between requests in milliseconds
REQUEST_DELAY_MS=500

# Server port
PORT=3001

# Database URL (SQLite)
DATABASE_URL="file:./dev.db"

# === Module 2: Narration Studio (optional) ===
# Get your API key from: https://aistudio.google.com/apikey
AI_PROVIDER=gemini
AI_MODEL=gemini-1.5-flash
GEMINI_API_KEY=your_gemini_api_key_here
```

### 4. Initialize Database

```bash
npm run db:push
```

### 5. Start Development Server

```bash
npm run dev
```

This starts both the backend (http://localhost:3001) and frontend (http://localhost:5173).

Open your browser to **http://localhost:5173**

## Usage

### Adding a Series

1. Click **Add Series** in the sidebar
2. Choose detection mode:
   - **Auto-Detect Pattern**: Paste 3 consecutive chapter URLs (e.g., chapter 1, 2, 3)
   - **Manual URL List**: Paste a list of chapter URLs (one per line)
3. Review the detected URL pattern and edit if needed
4. Click **Discover Chapters** to find all available chapters
5. Select which chapters to add (use range selector for bulk selection)
6. Enter a title and click **Create Series**

### Downloading Chapters

1. Go to a series detail page
2. Select chapters to download:
   - Check individual chapters
   - Use "Select Pending" for all undownloaded
   - Use range input for specific chapter range
3. Click **Download**
4. Monitor progress in the **Downloads** page

### File Structure

Downloaded files are organized as:

```
<DOWNLOAD_ROOT>/
└── <Series Title>/
    ├── about.md                    # AI-generated series overview (Module 2)
    ├── Part 01 - full script.md    # Exported Part script (Module 2)
    ├── Chapter 001/
    │   ├── page_001.webp
    │   ├── page_002.webp
    │   ├── script.md               # Narration script (Module 2)
    │   ├── outro.md                # Part outro if this chapter ends a Part
    │   └── ...
    ├── Chapter 002/
    └── ...
```

## Module 2: Narration Studio

### Getting a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Create a new API key
4. Add it to your `server/.env` file as `GEMINI_API_KEY=your_key`

### Generating Scripts (API Mode)

1. Ensure you have a valid `GEMINI_API_KEY` in your `.env`
2. Go to **Narration Library** (sidebar)
3. Click on a series with downloaded chapters
4. Select a chapter or use **Generate Range** to generate multiple
5. The AI will analyze the chapter images and create a narration script
6. Edit the script as needed, then **Save**

### Generating Scripts (Manual Mode)

If you don't have an API key or prefer using another AI:

1. Open a chapter in the Script Editor
2. Switch to **Manual Mode** tab
3. Click **Load Prompt** to get the formatted prompt
4. **Copy** the prompt
5. Open your preferred AI chat (ChatGPT, Claude, Gemini web, etc.)
6. Paste the prompt and **attach the chapter images**
7. Copy the AI's response
8. **Paste** it back into the editor and **Submit**

### Story Continuity

The system maintains automatic continuity across chapters:

- **Chapter 1**: Generates an "About this Manhwa" overview + chapter summary
- **Chapters 2+**: Reads the previous chapter's summary and closing paragraph to continue seamlessly
- **Rolling Summary**: Each chapter's summary incorporates all previous events

**Important**: Generate chapters in order. If you skip chapters, the continuity will have gaps.

### Parts (Video Grouping)

Parts let you group consecutive chapters for video production:

1. In the Script Editor, toggle **End of Part** for the last chapter of each Part
2. Click **Generate Outro** to create closing lines for that Part
3. Use **Export Part** to concatenate all chapter scripts + outro into one file

### Editing Scripts

- Edit the script text directly in the editor
- After editing, click **Regenerate Summary** to update the continuity metadata
- Downstream chapters will be marked as "Stale" if their continuity source changed

## Module 2 Part 2: Voiceover

### Prerequisites for Voiceover

1. **FFmpeg** must be installed and available in your system PATH:
   ```bash
   # Check if FFmpeg is installed
   ffmpeg -version
   ```

2. **Gemini API Key** - Same key used for script generation

### Generating Voiceover

1. Generate a script first (see Module 2 above)
2. In the series chapter list, click **Voice** button on any scripted chapter
3. Click **Auto-Split Script** to create voice sections
4. Select your preferred voice from the dropdown (8 Gemini voices available)
5. Click **Generate All** to generate audio for all sections
6. Once all sections are done, click **Join All Sections** to create the final chapter audio
7. Download the MP3 or play it directly in the browser

### Voice Options

| Voice | Description |
|-------|-------------|
| Aoede | Bright and clear |
| Charon | Deep and resonant |
| Fenrir | Bold and powerful |
| Kore | Warm and expressive |
| Leda | Soft and gentle |
| Orus | Calm and measured |
| Puck | Playful and energetic |
| Zephyr | Light and airy |

### Section Management

- **Edit Section**: Click the menu on any section to edit its text
- **Add Section**: Add new text sections manually
- **Delete Section**: Remove unwanted sections
- **Upload Audio**: Upload your own audio recording for any section
- **Regenerate**: Regenerate audio for a specific section with different settings

### Voice Analysis (Optional)

For uploaded audio or to verify voice consistency:

1. Install Python dependencies:
   ```bash
   pip install resemblyzer librosa numpy
   ```

2. The analysis will automatically check if all audio files use the same voice
3. Results show similarity scores between sections

### Output Files

Voiceover files are saved in:
```
<DOWNLOAD_ROOT>/
└── <Series Title>/
    └── Chapter XXX/
        └── audio/
            ├── section_001.wav    # Individual section audio
            ├── section_002.wav
            ├── chapter_XXX.mp3    # Joined chapter audio
            └── ...
```

## Module 3: Image Clipper

Crop a chapter's downloaded pages into ordered images for the video.

### Workflow
1. Pick a series, then a chapter, to open the crop workspace.
2. **Click** anywhere on the page to drop a full-width 1:1 crop; drag its edges/corners to set height and width.
3. Crops are numbered top-to-bottom (story order); inserting/moving renumbers automatically.
4. Optionally **Crop using AI** to get suggested crops to accept/reject.
5. **Save all crops** to export them to disk.

### Output Files
```
<DOWNLOAD_ROOT>/<Series Title>/Chapter XXX/crops/<series-slug>_crop_001.png
```
The absolute export path is stored on each `Crop.exportPath` and is the source of truth used by Module 4.

### Key Endpoints (`/api/clipper`, `/api/ai-crop`)
- `GET /clipper/series`, `GET /clipper/series/:id` — eligible series + chapters
- `GET /clipper/chapters/:id/manifest`, `GET /clipper/chapters/:id/image/:filename`
- `POST /clipper/chapters/:id/session`, crop CRUD under `/clipper/sessions` and `/clipper/crops`
- `POST /clipper/sessions/:id/finalize` — export crops to disk

### Socket.io Events
- `clipper:finalize-progress`, `clipper:finalize-complete`

## Module 4: Video Editor

Compiles narration scripts + per-section voiceover audio + cropped images into a single 16:9 MP4, spanning one or more chapters as one continuous video.

### Workflow
1. Sidebar → **Editor**, pick a series.
2. Select the chapters to include (only chapters with **finalized crops** *and* **per-section voiceover audio** are eligible). Chapters compile into the timeline sequentially.
3. For each script part (the part's audio is the master clock): select images from the chapter's crop pool (or add a black filler), drag the slot boundaries to set per-image durations (the sum is locked to the audio), and tune motion/anchor/scale per image in the inspector.
4. The final **End Card** part shows an editable title-card text + duration.
5. Set **Audio & Music** (background track + master/music volume), **Preview** (live or rendered), then **Export**.

### Core Editing Model
- The atomic unit is a **script part**, backed by an `AudioSection` whose audio is never trimmed/stretched.
- Selected images appear in **crop-number order** (no manual reordering); selecting/deselecting changes the set, durations re-split equally on add/remove.
- **Foreground**: fit to frame height, centered; **background**: a blurred, 20%-darkened copy; cuts between images are instant.
- **Motion**: gentle drift (zoom/pan) by default; **focus mode** (manual) zooms toward a placed anchor point.
- **Outro**: the editor-managed end title card renders for a fixed duration (no outro audio exists in the pipeline); background music continues underneath.

> Note: the title card is rendered with **sharp** (SVG→PNG), not FFmpeg `drawtext`, so card text works even on FFmpeg builds without `drawtext`/libfreetype.

### Prisma Models (Module 4)
- `VideoProject` — an export project for a series (chapter list, music track, master/music volume, title-card text/duration, status)
- `VideoPartEdit` — one row per script part (+ a final outro row); `audioSectionId` is null for the outro
- `VideoPartImage` — a selected crop or filler in a part (slotIndex from crop order, duration, motion/anchor/transform, `source`)
- `MusicTrack` — a global background-music track
- `VideoExport` — a render job (output path, resolution, preset, size, duration, status)
- `VideoEditEvent` — an edit-event log for the future style model (`image_selected`/`deselected`, `duration_adjusted`, `motion_changed`, `anchor_set`/`moved`, `image_transformed`, `filler_used`, `suggestion_accepted`/`edited`/`rejected`)

### API Endpoints (`/api/video`)
- `GET /capabilities` — FFmpeg + filter availability, resolutions, AI-assist availability
- `POST /projects/init`, `GET /projects/:id`, `PUT /projects/:id`
- `GET /series/:seriesId/editable-chapters`, `GET /series-status`, `GET /chapters/:chapterId/crops`
- `PUT /parts/:partId/images` — bulk-set a part's images (normalizes durations, derives slotIndex, logs an event)
- `POST /parts/:partId/event` — log a standalone edit event
- `POST /projects/:id/render`, `POST /exports/:exportId/cancel`, `GET /exports/:exportId`, `GET /exports/:exportId/open`, `GET /exports/:exportId/file`
- `POST /projects/:id/preview` (proxy draft), `GET /projects/:id/preview/file`
- `GET /parts/:partId/audio`, `GET /crops/:cropId/image`
- Music: `GET /music`, `POST /music` (upload), `DELETE /music/:id`, `GET /music/:id/file`
- AI assist: `POST /parts/:partId/suggest-images`, `POST /images/:imageId/suggest-anchor`

### Socket.io Events
- `video:render-progress`, `video:render-complete`, `video:render-failed`, `video:render-cancelled`
- `video:preview-progress`, `video:preview-complete`

### Disk Layout
```
<DOWNLOAD_ROOT>/<Series Title>/_video/<project-slug>_<resolution>_<timestamp>.mp4   # rendered videos
<DOWNLOAD_ROOT>/_music/<timestamp>_<filename>                                       # global music library
<OS temp dir>/mhs_preview_*.mp4                                                     # proxy previews (ephemeral)
```

### AI Assist (zero-shot, optional)
Requires `GEMINI_API_KEY`. Uses Gemini vision to (a) suggest the contiguous crop range that illustrates a part (monotonic story-order alignment) and (b) suggest a focus anchor for an image. Suggestions are pre-filled for accept/edit/reject; the accepted/edited/rejected signal is logged via `VideoEditEvent` for a future trained style model. (Capturing the script→crop mapping at generation time isn't applicable here — crops don't exist until Module 3 and parts are voiceover-derived — so the zero-shot range alignment is the mechanism.)

### FFmpeg Requirements
FFmpeg must be on `PATH` (or set `FFMPEG_PATH`/`FFPROBE_PATH`). The engine detects `zoompan`, `gblur`/`boxblur`, and degrades gracefully (e.g. `gblur`→`boxblur`, missing `zoompan`→static holds). Export is disabled with a clear message if FFmpeg is unavailable. Optional `VIDEO_FONT_FILE` is unused for the card (sharp renders text).

## Configuration

### Settings Page

Access via sidebar → **Settings** to configure:

- Download root folder
- Max concurrent downloads
- Request delay (rate limiting)
- User-Agent string
- Image detection thresholds

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DOWNLOAD_ROOT` | Root folder for downloads | `./downloads` |
| `CONCURRENCY` | Max concurrent downloads | `3` |
| `REQUEST_DELAY_MS` | Delay between requests | `500` |
| `PORT` | Server port | `3001` |
| `DATABASE_URL` | SQLite database path | `file:./dev.db` |
| `AI_PROVIDER` | AI provider for narration | `gemini` |
| `AI_MODEL` | AI model name | `gemini-1.5-flash` |
| `GEMINI_API_KEY` | Google Gemini API key | *(required for API mode)* |
| `TTS_DEFAULT_VOICE` | Default TTS voice | `Kore` |
| `PYTHON_PATH` | Path to Python (for voice analysis) | `python3` |

## Troubleshooting

### 403 Forbidden on Image Downloads

Some CDNs require proper `Referer` and `User-Agent` headers. The app automatically sets these, but if you still get 403 errors:

1. Check Settings → User-Agent is set to a valid browser string
2. Some sites may have stricter bot protection that cannot be bypassed

### Pattern Detection Fails

If auto-detection doesn't work:
1. Use "Manual URL List" mode instead
2. Or manually enter the URL template with `{n}` placeholder

### Cloudflare / Bot Protection

The app does NOT attempt to bypass CAPTCHAs, login walls, or advanced bot protection. If a site uses these, you'll see a clear error message.

### Images Not Detected

1. Check Settings → Minimum Image Width (default 400px)
2. Check Settings → Minimum Aspect Ratio (default 0.8)
3. The page may use non-standard image loading techniques

## API Endpoints

### Series
- `GET /api/series` - List all series
- `GET /api/series/:id` - Get series with chapters
- `POST /api/series` - Create series
- `POST /api/series/infer-pattern` - Detect URL pattern
- `POST /api/series/discover-chapters` - Auto-discover chapters

### Downloads
- `GET /api/downloads/status` - Queue status
- `POST /api/downloads/queue` - Add chapters to queue
- `POST /api/downloads/pause` - Pause downloads
- `POST /api/downloads/resume` - Resume downloads
- `POST /api/downloads/retry-failed` - Retry failed chapters

### Settings
- `GET /api/settings` - Get all settings
- `PUT /api/settings` - Update settings

## WebSocket Events

- `queue:status` - Download queue status updates
- `chapter:progress` - Per-chapter download progress
- `chapter:status` - Chapter status changes
- `discovery:progress` - Chapter discovery progress
- `narration:progress` - Script generation progress
- `narration:range-progress` - Multi-chapter generation progress
- `narration:range-complete` - Multi-chapter generation complete
- `voiceover:section-start` - Section audio generation started
- `voiceover:section-complete` - Section audio generation complete
- `voiceover:batch-start` - Batch generation started
- `voiceover:batch-progress` - Batch generation progress
- `voiceover:batch-complete` - Batch generation complete
- `voiceover:join-start` - Audio join started
- `voiceover:join-complete` - Audio join complete

## Database Schema

```prisma
model Series {
  id          String    @id
  title       String
  sourceSite  String
  coverPath   String?
  rootFolder  String
  urlTemplate String?
  chapters    Chapter[]
}

model Chapter {
  id              String
  seriesId        String
  number          Float     // Supports 10.5 style chapters
  title           String?
  sourceUrl       String
  folderPath      String
  status          String    // pending|queued|downloading|done|failed|skipped
  pageCount       Int?
  downloadedCount Int
  error           String?
  pages           Page[]
}

model Page {
  id        String
  chapterId String
  index     Int
  sourceUrl String
  localPath String?
  status    String    // pending|done|failed
  bytes     Int?
}
```

## Project Structure

```
Manhwa studio 2/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Page components
│   │   ├── lib/            # Utilities & API
│   │   └── App.tsx
│   └── package.json
├── server/                 # Express backend
│   ├── src/
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   ├── utils/          # Helpers
│   │   └── index.ts
│   ├── prisma/
│   │   └── schema.prisma
│   └── package.json
├── .env.example
├── package.json
└── README.md
```

## License

MIT
