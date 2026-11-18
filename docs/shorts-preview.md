# Shorts

Open **Video Editor → Shorts**, directly below Editor 2.0. Folders under the workspace's `exports/` directory appear automatically; paste another local folder path and choose **Load folder** to load it. The Grand Duke 40-second package is selected on the first visit when available. Studio remembers the last loaded folder.

Choose **Generate preview** to render a 540 × 960, 30 fps MP4. The page shows progress, cancellation, video playback, shot inspection, seeking by shot, and an MP4 download. Completed previews reconnect after navigation, page reloads, and server restarts. Artwork, timeline and audio changes invalidate the render cache.

Each extracted package needs:

- One `*.timeline.json`, or a `*.editor2.json` fallback, containing one section with a continuous `timelines` array starting at zero. Full timeline JSON takes precedence over the minimal Editor 2 version.
- A `crops3/` folder containing all `selectedImages` filenames. Files cannot escape the package through paths or symlinks.
- Optional audio named `voiceover.en.wav`, `voiceover.mp3`, `narration.wav`, or an equivalent supported WAV/MP3/M4A/AAC/OGG name. Reload after adding audio. Short audio is padded; long audio is trimmed to the timeline.

Full timeline slots may contain `narration`, `on_screen_text`, `edit_note`, and `motion.effect` (`zoom-in`, `zoom-out`, `pan-up`, `pan-down`, `pan-left`, `pan-right`). The page displays narration and edit notes. Renders include on-screen text, gentle motion, and supplied audio. Music and effect descriptions are editing notes, and the script is not synthesized into speech.

The preview uses the timeline duration independently of full-recap chapter audio. Original package files and Editor 2 chapter records are not modified. FFmpeg is required (`FFMPEG_PATH` can override its executable); Sharp composes artwork and text. Generated files are cached in `server/private/shorts-previews/` and ignored by Git. The folder API is restricted to loopback requests; mutations require the Studio client header.

Validation rejects ambiguous timeline files, noncontinuous timings, durations above 180 seconds, missing sections, unsafe asset paths, and stale revisions. Missing or unreadable images are listed in the page and block rendering. Preview output uses contained artwork over a blurred background with captions near the lower third; source framing and audio timing can be refined in the package before reloading.
