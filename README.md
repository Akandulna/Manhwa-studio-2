# Manhwa Studio

A local desktop app that turns manhwa chapters into narrated videos. It
downloads chapters itself; the **Sleeper-Cell** Android phones do the rest of
the production work — writing narration scripts, recording voiceovers and
marking crop boxes — and upload it to Cloudflare R2. Manhwa Studio brings that
work onto the Mac, aligns the voiceover, cuts the crops and renders the video.

## Modules

### Library & Downloader
- **Shared library**: a newly added series is listed on the Mac and every Sleeper-Cell phone automatically.
  The device that adds it owns the source downloads. Once its download batch finishes it detects repeated
  intro/outro artwork, keeps the originals, and joins/splits the pages before sharing them through R2.
  The other devices download those prepared chapters automatically; they do not fetch the original website.
  Offline devices catch up when they reconnect. This requires the updated relay and Android app.
- **Add Series**: paste 3 seed URLs to detect the chapter URL pattern and
  discover chapters, or upload pages by hand (manual mode).
- **Library / Series detail**: download chapters (Playwright headless browser,
  concurrent queue, resume and retry), preview a chapter's pages and delete
  unwanted ones into a restorable bin.
- **Production process**: expand a series in the Library and use **Run Sleeper-Cell automation**
  to choose a primary device, per-phone profiles and Image Clipping settings. Choose **Parallel devices**
  to share unfinished voiceover and clipping chapters between selected phones without overlap. Narration
  scripts stay on the primary phone in reading order. It resumes the first unfinished step,
  then runs scripts → English and Hinglish voiceovers → Image Clipping in order. Preparation
  must be complete first. Voiceovers are fetched and aligned on the Mac automatically.
  The sequence continues after closing the dialog and stops for manual review before Editor 2.0.
  The Library shows its running/review status; reopen it to stop a run or resume after an error.
  After a server restart, runs are marked interrupted so a possibly delivered phone command is
  never replayed automatically.
- **Downloads**: the live queue — pause, resume, retry failed.
- **Page Stitcher**: joins chapters of 200–300 short pages into tall pages;
  auto-stitch cuts at blank rows and drops repeated intro/outro pages.
- **Send to phone** zips chapters to R2 for the phones (optionally on its own
  after downloads); **Get from phones** brings in what the Master phone
  downloaded.
- To resend updated page images, open **Send to phone**, enable **Replace pages & reset Image Clipper**,
  expand the series and select the chapters, then use **Replace & reset**. Finished chapters can be selected.
  The current page images replace their R2 ZIPs without running preparation again. After upload, old local
  crop JSON, metadata, review, cut images, slices and Processed drop-offs move into the chapter's
  `.page-replacements/<revision>/` backup. Scripts, voiceovers and alignment stay intact. Old cloud crop ZIPs,
  Cropped markers and shared crop files are removed. Every phone needs the matching updated Sleeper Cell build;
  it downloads the new revision, backs up its clipping state and starts Image Clipper fresh when idle.
  Offline phones catch up on reconnect; crops from an older page revision cannot be imported over the reset.

### Narration Library
Manhwa → English / Hindi → chapters.
- **Fetch from phone** pulls the chapters' scripts and voiceover audio from R2
  (new and re-uploaded chapters are ticked by default).
- Alignment runs **automatically** after a fetch: WhisperX force-aligns each
  voiceover section against its script, and once the whole chapter is aligned
  the alignment document is written next to it (`script-timeline.md`, or
  `script-timeline.hi.md` for Hindi).
- **Align again** re-runs alignment for a chapter that failed or is incomplete.
- **Replace** on a chapter opens its saved local script. Keep that text (including edits already made on disk),
  choose a `.md`/`.txt` file, or paste a revision, then use **Replace & send**. This backs up the script and
  that language's audio, alignment and Editor paste under the chapter's `.script-replacements/` folder,
  clears the old results, and sends the revised script through the phones' shared-script sync. Updated
  Sleeper-Cell builds apply it when idle and prepare fresh splits; use **Check for new uploads** after stopping
  an active run. Generate the new voiceover, fetch it here for alignment, and continue in Editor 2.0.
  A failed phone upload can be retried from Replace without resetting the saved revision again.
- To revise a script on Sleeper-Cell, use **Workspace → Scripts → series → chapter → ⋮ → Replace**
  on `script.md` or `script.hi.md`, then generate its new voiceover. Fetching replacement audio backs up and
  clears that language's old Editor timeline, realigns the sections, and sends a fresh Editor package once ready.
  Old phone timelines are not imported over the cleared paste. Run Editor again, fetch its new timeline,
  process and export the revised chapter. Existing rendered videos are retained.

### Image Clipper 3.0
Manhwa → chapters → pages.
- **Get from phones** brings in the pages the Master phone downloaded (also on the Library).
- **Sync json** pulls the phones' crop JSON for each chapter.
- **Preview** shows every page's crop boxes, lets you move/resize/delete them,
  and marks the chapter reviewed.
- **Crop Sections** cuts the images into `crops3/`. A chapter already reviewed
  on the Master phone is cut automatically as soon as it syncs; any other
  chapter waits until it has been reviewed in Preview.
- Slice pages into parts and unsync chapters from the series view.

### Editor 2.0

- **Small batches** builds timelines through resumable visual indexing, narration routing, selection,
  review and targeted repair. Each prompt is capped at 6,000 characters. It supports manual copy/paste
  and updated Sleeper-Cell automation with selectable models; one-shot stays available.
  See [the staged timeline guide](docs/editor-timeline-stages.md) for usage and the phone build requirement.
Manhwa → chapters, per language.
- A per-chapter checklist: **voiceover audio**, **alignment**, **timeline
  JSON** and **cropped images**. Preview and Export stay locked until all four
  are there.
- The timeline JSON comes from **Copy All** (prompt + script with timeline +
  crop metadata) → ChatGPT → **Paste**, or from the timelines the phone made
  (**Fetch from phone**). **Send to phone** hands the phone's Editor run the
  packages it needs; **Check Images** repairs missing image references.
- **Copy All** recovers the saved Editor instructions from Manhwa Studio when the browser has no local
  prompt. It refuses to copy a package without instructions. Settings retains prompt saves on the desktop
  before trying to upload them to the phone, so an R2 failure does not lose the prompt.
- Export renders one MP4 per chapter into the series' `_video2/` (or
  `_video2_hi/`) folder.
- Each processed chapter has its own **Export** or **Re-export** button. Processing a chapter again marks its
  older video **Re-export ready** and includes that chapter in the next batch export. Other finished chapters
  stay out of that batch. Re-export writes a new MP4 and retains the previous render.
- Series show **Done** in Editor 2.0 when the selected language's video folder
  has a nonempty video in `compressed` (also `Compressed` or `Compress`). This
  remains visible after cleaning up original renders. Use **Rescan** on the
  series list after adding or removing a compressed video.

### Sleeper Cells
- **Phone Status** — each phone's runs, with Run automation / Stop, Wake,
  Screen off and Screenshot (live through the relay when configured).
- **Accounts** — ChatGPT profiles, plans and upload limits.
- **Live Progress** — what every phone is working on.

### Settings
Appearance (light / dark / system), Download & Performance (concurrency,
request delay, user agent, image thresholds), the Editor 2.0 prompt (also synced to R2
for the phone), Cloudflare R2 + phone relay, and **Storage** — disk usage per
manhwa, cleanup of exported chapters, and "Complete & delete" per Part.
Storage also offers **Delete renders** for each `_video`, `_video2`, or
`_video2_hi` folder once its `compressed` subfolder contains a nonempty video
(`Compressed` and `Compress` are also supported). Click **Rescan** after adding
the compressed video. Confirming deletes only the original MP4s directly in
that render folder and keeps the compressed folder and its contents.

## Tech Stack

- **Frontend**: React + Vite + TypeScript + Tailwind CSS + shadcn/ui
- **Backend**: Node.js + Express + TypeScript, Socket.io for live progress
- **Scraping**: Playwright (headless Chromium) + p-queue
- **Database**: SQLite via Prisma
- **Images**: sharp · **Audio / video**: FFmpeg
- **Alignment**: WhisperX (wav2vec2) through a Python sidecar (`server/scripts/align.py`)
- **Cloud**: Cloudflare R2 (S3 API) + a Worker relay (`relay/`) for live phone status

## Prerequisites

- Node.js 18+
- FFmpeg on `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`) — `brew install ffmpeg`
- Python with WhisperX for alignment: a venv at `server/.venv-whisperx`, or set
  `WHISPERX_PYTHON_PATH`

## Setup

```bash
npm install               # root, server and client
npx playwright install chromium   # for the downloader
cp server/.env.example server/.env
npm run db:push           # create / update the SQLite database
npm run dev               # API on :3002 + client on http://localhost:5173
```

Set up Cloudflare R2 in **Settings → Cloudflare** (it writes the `R2_*` lines in
`server/.env`, no restart needed). The bucket is on the free plan, so the app
never polls it: library changes arrive through the relay, with an R2 catch-up at startup.
Other production files are read when you press Fetch / Sync / Get from phones.

Shared library catalogs are stored as `<prefix>library/<origin device id>.json` and relayed as `library`
receipts to desktops and phones, including on reconnect. Catalogs list chapters immediately and include ZIP
versions only after preparation/upload. The Mac automatically imports them into its database and download
folder; phones automatically import their Master Library rows and use ManhwaSync to fetch the pages.
Clearing a local shared-library copy retains its R2 ZIP for devices that are offline.

Library production tracking uses fixed 20-chapter parts: 1–20, 21–40, and so on.
Its accordion groups show how many consecutive parts have completed. Every chapter in
a part must have Editor 2.0 exports in **both English and Hinglish**; missing chapters
keep the part open. The expanded tracker shows preparation, scripts, voiceover splits
and audio, alignment, crop JSON/review/cropping, and timeline/processed/export counters.
Completion only updates the tracker; Storage's separate archival action remains manual.

Saved phone facts travel as `process` relay receipts. The Mac combines them with local
file and database evidence, pushes changes to its Library over Socket.IO, and publishes
the combined snapshot to the relay and `<prefix>progress/<Mac device id>.json` in R2.
Phones receive live updates and cached relay receipts on reconnect, with R2 catch-up
when Library sync reconnects. Alignment, final cropping, processing and exports are
desktop facts. A stage completed on several devices counts once.

Existing desktop series are registered for sharing automatically; phone imports keep their original owner.
Catalogs use the phones' chapter-download prefix even when the Mac's production files use another prefix.
Sleeper-Cell's Library automatically indexes `Workspace/Manhwa/<Series>/<Chapter>/`, including folders
downloaded before shared catalogs existed. Discovering a folder does not make that phone its download owner.
Legacy registration preserves upload preferences and does not prepare or rewrite existing pages.

Each Library series has an actions menu with **Mark Part 1 done** (and undo) and **Delete series everywhere**.
Part marks sync between devices and change the tracker without fabricating exports or deleting files.
Global deletion requires confirmation, removes the series' files from all workspace areas and R2, and keeps
a shared deletion record so an offline device cannot restore it from an old catalog. Offline phones apply
deletion after updating Sleeper-Cell and reconnecting; failed cleanup retries automatically.

### Mac App (optional)

```bash
npm run app
```

Builds the client, packages `desktop/` with Electron and installs **Manhwa Studio.app** into `/Applications`.
The app is a shell around this repo, not a standalone bundle: it runs the server from `server/`
(same `.env`, database and `downloads/`) using your system Node, and loads the built client
the server serves on `PORT`. If a server is already running on that port (e.g. `npm run dev`) the app
just attaches to it; otherwise it starts one and stops it on quit.

- **UI changes** need `cd client && npx vite build` (then **View → Reload**); server changes need **Server → Restart Server**. No app rebuild needed for either.
- **Server log:** `~/Library/Logs/Manhwa Studio/server.log` (**Server → Open Server Log**).
- The repo's path is baked in at build time — re-run `npm run app` if you move the repo.
- `npm run dev` can't start while the app runs its own server (port in use); start dev first, or quit the app.

## Disk Layout

```
<DOWNLOAD_ROOT>/
└── <Series Title>/
    ├── Chapter 001/
    │   ├── page_001.jpg …             # pages (downloaded or Get from phones)
    │   ├── script.md, script.hi.md    # narration scripts (Fetch from phone)
    │   ├── audio/, audio_hi/          # voiceover sections
    │   ├── script-timeline.md, script-timeline.hi.md   # alignment documents
    │   └── crops3/                    # cut images (Crop Sections)
    ├── _video2/, _video2_hi/          # rendered videos
    └── …
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DOWNLOAD_ROOT` | Folder every series lives under | `./downloads` |
| `DATABASE_URL` | SQLite database | `file:./dev.db` |
| `PORT` | Server port (the client expects 3002) | `3001` |
| `CONCURRENCY`, `REQUEST_DELAY_MS` | Downloader concurrency and delay between pages | `3`, `500` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PREFIX` | Cloudflare R2 (set from Settings → Cloudflare) | — |
| `RELAY_URL`, `RELAY_TOKEN` | Phone relay Worker (live phone status) | — |
| `WHISPERX_PYTHON_PATH` | Python with WhisperX, for alignment | `server/.venv-whisperx` |
| `FFMPEG_PATH`, `FFPROBE_PATH` | FFmpeg binaries | on `PATH` |

## Project Structure

```
Manhwa studio 2/
├── client/      # React frontend (pages/, components/, lib/api.ts)
├── server/      # Express backend (routes/, services/, prisma/schema.prisma)
├── relay/       # Cloudflare Worker + Durable Object relay for the phones
├── desktop/     # Electron shell (Mac app)
└── package.json
```

## License

MIT
