# Copy thumbnail reference images

The Generate thumbnails in ChatGPT dialog includes **Copy reference images** next to the prompt copy button. Paste the prompt into ChatGPT first, then copy references and press Cmd+V in ChatGPT to attach them. A clipboard copy replaces the previous contents. The reference pack remains available as a download alternative.

The button copies the selected generation request's saved PNG reference snapshots in order, named reference-1.png through reference-10.png. Edit requests also include base-thumbnail.png. Later changes to the live reference selection do not alter older requests. It copies individual files rather than a combined image, URLs, or a ZIP.

On the local macOS Studio server, an explicit POST loads and verifies all saved request images, writes private temporary PNG files, and uses a fixed AppKit program through osascript to populate the native file clipboard. Paths are separate argv values and never interpolated into a shell or script. The program writes NSURL items and a complete filename property list, checking the copied count. Files survive the HTTP response for pasting; a later successful copy cleans up the prior file set. Native copy operations are serialized. Failed writes clean up their new files and return an error rather than a success notice.

The endpoint requires a loopback client, explicit X-Studio-Clipboard header, and a matching local Origin (or the local Vite development UI on HTTP port 5173) when provided; cross-site requests are rejected. It accepts only series/request IDs and resolves saved images through the existing scoped store. Remote clients and non-macOS hosts use the downloadable pack. No AI request or upload is sent by the copy action.

Validation: 56 focused YouTube tests, client/server TypeScript, web bundle build, and native Chromium Cmd+V into a local paste receiver using synthetic images. Verified three separate PNG reference files with correct names/signatures and four files for an edit request including its base thumbnail; checked the narrow-screen dialog. No images were uploaded to ChatGPT during validation.
