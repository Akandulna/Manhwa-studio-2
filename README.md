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

### Module 3: Image Clipper 3.0
- **Per-Image Crops**: Every page has its own crop JSON, normalized 0.0–1.0 against that page alone — no stitched chapter canvas
- **ChatGPT Flow**: Build a page's handoff package, paste ChatGPT's analysis back, review and adjust the crops, then export
- **ChatGPT API Auto Run**: Runs package → analysis → review → export through the OpenAI API (key set in Settings → Crop 3.0 - Prompts)
- **Crop Rules**: The guidelines document (Settings → Crop Pointers) is handed to the model verbatim
- **Slicing & Sync**: Slice tall pages into parts; import hand-made crop JSON from a series' `Processed/` folder

### Module 4: Editor 2.0
- **Readiness Gates**: A chapter is editable once it has a script, section voiceover audio, Clipper 3.0 crops for every page, and a "script with timeline" on every section
- **Timeline JSON**: Paste a chapter's timeline JSON to build the plan; preview it with Ken Burns motion over a blurred backdrop
- **Batch Export**: Render one MP4 per chapter into the series' `_video2/` folder, with progress and cancel
- **Music Library**: Global background tracks (sidebar → **Music**)

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

### 6. Mac App (optional)

```bash
npm run app
```

Builds the client, packages `desktop/` with Electron and installs **Manhwa Studio.app** into `/Applications`.
The app is a shell around this repo, not a standalone bundle: it runs the server from `server/`
(same `.env`, database, `downloads/` and ML venvs) using your system Node, and loads the built client
the server serves on `PORT`. If a server is already running on that port (e.g. `npm run dev`) the app
just attaches to it; otherwise it starts one and stops it on quit.

- **UI changes** need `cd client && npx vite build` (then **View → Reload**); server changes need **Server → Restart Server**. No app rebuild needed for either.
- **Server log:** `~/Library/Logs/Manhwa Studio/server.log` (**Server → Open Server Log**).
- The repo's path is baked in at build time — re-run `npm run app` if you move the repo.
- `npm run dev` can't start while the app runs its own server (port in use); start dev first, or quit the app.

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

## Module 3: Image Clipper 3.0

Crop each downloaded page into ordered images for the video. Each page is independent: its crop JSON's coordinates are normalized against that page only.

### Workflow
1. Sidebar → **Image Clipper 3.0**, pick a series, then a chapter.
2. Per page, either run the **ChatGPT flow** (build the package, paste the reply, review, export) or the **ChatGPT API** auto run.
3. Exported crops and their JSON land in the chapter folder for Editor 2.0.

### Key Endpoints (`/api/clipper3`)
- `GET /status`, `GET|PUT /guidelines`, `POST /guidelines/reset` — the crop rules document
- `GET /series`, `GET /chapters`, `GET /series/:seriesId/summary` — listing and progress
- `GET /chapters/:id/images`, `GET /chapters/:id/image/:filename` — pages and their state
- Per page under `/chapters/:id/images/:filename/…`: `points`, `metadata`, `slices`, `handoff`, `analysis`, `review`, `export`
- `GET|POST /chapters/:id/auto`, `POST /chapters/:id/auto/cancel` — the ChatGPT API run
- `POST /series/:seriesId/sync-processed`, `POST /series/:seriesId/unsync-processed` (+ `/preview`)

## Module 4: Editor 2.0

Turns each chapter's timeline plan into a 16:9 MP4.

### Workflow
1. Sidebar → **Editor 2.0**, pick a series; chapters show which readiness gates they pass.
2. Paste the chapter's timeline JSON, check it in the preview, then export one or all chapters.

### API Endpoints (`/api/video2`)
- `GET /series/:seriesId/editable-chapters` — chapter readiness
- `GET /chapters/:chapterId/timeline-bundle`, `GET /chapters/:chapterId/crop-metadata-bundle`, `POST /chapters/:chapterId/process-timeline`
- `POST /series/:seriesId/check-image-refs` — repair missing image references
- `POST /series/:seriesId/export-all`, `GET /series/:seriesId/exports`, `GET /exports/:jobId`, `POST /exports/:jobId/cancel`

### Music Library (`/api/music`)
- `GET /`, `POST /` (upload), `DELETE /:id`, `GET /:id/file`

### Disk Layout
```
<DOWNLOAD_ROOT>/<Series Title>/_video2/…mp4          # rendered videos
<DOWNLOAD_ROOT>/_music/<timestamp>_<filename>        # global music library
```

### FFmpeg Requirements
FFmpeg must be on `PATH` (or set `FFMPEG_PATH`). The engine detects `zoompan`, `gblur`/`boxblur`, and degrades gracefully (e.g. `gblur`→`boxblur`, missing `zoompan`→static holds).

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
