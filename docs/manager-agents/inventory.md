# Entry points, status sources, and owners

Inspected Studio and sibling `../MAPI/Sleeper-cell-main` sources on 18 October 2026. Classification describes the required future managed-mode behavior; no runtime block is installed in Phase 0. Enrollment is per workspace/workflow/entity, not only per Studio window. Default for any unlisted mutation is **blocked during managed execution** until audited. This default is essential for old clients and newly added routes.

## Execution entry points

| Surface / source | Existing behavior and boundary | Managed enrollment classification |
|---|---|---|
| Library SeriesAutomationDialog; series POST `/:id/automation` and `/stop` | ProductionRunner saves job/recipient intent, sequences preparation → scripts → voice → clipping → review; start/resume recalculates progress, process-local overlap checks | Integrate through authority in Phase 3; current implementation not safe across Studio instances |
| RunAutomation, PhoneStatus, LiveProgress; r2 POST `/phone/automation`, `/plan` | r2Service.sendAutomationCommand → phoneRelay.sendPhoneRequest; start kinds clipper/narration/voiceover/editor; immediate or finish-current stop; split assignments | Integrate enrolled kind/unit; reject unscoped/broadcast starts and overlap; preserve stop access |
| r2 `/phone/profile`, `/phone/readiness/fix`, `/phone/screen` | Profile selection/model settings, readiness and screen operations can mutate a busy session | Block conflicting selection/navigation; integrate with shared reservations; passive screenshot still requires evidence policy |
| r2 `/phone/request`, `/phone-send`, `/phone-send/auto`, `/phone-pull`, `/cancel` | Sync, upload/download, automatic sending and cancellation use existing queues | Integrate artifact/revision checks; transfer is not generation completion |
| Download queue/pause/resume/retry/clear; Stitch and manual uploads/import/reindex | Desktop queue and filesystem/page changes | Block conflicting units until Phase 7 integration; invalidation must precede accepted dependent work |
| Narration script replace/fetch, alignment/reset and manual edits | Script imports/replacement invalidate dependent state; alignment starts background work | Block conflicting managed dependencies or integrate revision transaction; preserve human review |
| Clipper3 points/metadata/review/crop/slices/fetch/sync/unsync | Manual edit, phone import and crop output publication | Block writes to enrolled revision unless using authority publication; review action remains explicit |
| Editor2 staged-timeline/process/save/send/fetch/export-all/cancel | Staged checkpoints and processing/export queues; per-language timelines | Unsupported for managed dispatch until Phase 7; block conflicting publication/start, allow stop |
| Storage archive/cleanup, chapter/series delete, part-completion override | Destructive maintenance or explicit manual marks | Block conflicts, never automatic repair; marks remain separate from evidence |
| Android master LibraryAutomationFragment / LibraryAutomationService | Independent phone-side coordinator; saves recipient list before remote starts, explicit interrupted resume | Block for managed scopes until it proposes via same authority; no competing scheduler |
| Android master RunAutomationSheet / MasterRelay | Manual remote starts/stops and multi-phone chapter assignment | Integrate at authority, reject legacy start without task/attempt |
| Android MainActivity startAutomationJob / resume + local run dialogs | AutoRun, VoiceoverRun, EditorRun, ClipperRun start, pause, resume, stop, stopAfterCurrent; rescope active chapter list | Integrate enrolled starts and rescope; resume requires handshake; stopping remains available offline |
| Android Automation.onRemote + StudioRelay / StudioRequests | `clipper_start`, `narration_start`, `voiceover_start`, `editor_start`, `clipper_stop`, `run_stop`, `run_finish`; also legacy polling/R2 paths | Block legacy commands for enrolled units; correlate accepted/started/stopped and deduplicate task/attempt/command |
| Android Automation.pending/startNow/rearm + AutomationService.runWake | Alarm and notification Start now/Cancel, boot rearming, quota-based scheduled resume | Block legacy scheduled start during enrollment; authority reconcile before new consequential action |
| Android ClipperPageFragment manual make/paste/export and narration/voice/editor screens | Manual browser/clipboard actions and local output publication can bypass run controls | Unsupported concurrent external activity; managed local publish must be fenced; hold profile if manual activity cannot be coordinated |
| Android ChapterUpload/ScriptUpload/PhoneShare/LibrarySync; desktop watchers/background queues | Automatic artifact transfers and receipt reporting after save/reconnect | Integrate revision/provenance before canonical import; replay outbound events without freshening source observation |

No centrally scheduled desktop production cron was found in the inspected runner; the concrete scheduled execution path is Android Automation's alarm/resume. Existing transfer retries, popup recovery, quota/profile rotation, and workflow correction loops must be accounted for by Phase 6's single recovery budget, not left running as independent retries under managed control.

## All 20 stage facts

The current `seriesProcess.ts::localStages/mergeRemote` projection is evidence to inspect, not a universal validator. `seriesProcessModel.mergeStage` selects furthest progress and lacks the proposed destination/freshness dimensions. An archived chapter currently marks all stages done; do not copy that shortcut into managed completion.

| Stage(s) | Responsible desktop manager | Existing source / validator and missing distinction |
|---|---|---|
| download | Library & Download | Chapter/Page rows + actual getImageFiles; phone sync receipt confirms phone files only |
| cleanup, stitch | Page Preparation | `.library-prepared.json`, `.stitch-originals/stitch.json`, stitch service/page replacement; marker existence alone is weak evidence of current bytes |
| script_en, script_hi | Narration & Alignment | ChapterScript + script file, scriptReplacement and phoneScriptImport; phone ScriptReceipt is locally saved, not Mac imported; Hindi sourceSha/review retained |
| split_en, split_hi | Narration & Alignment | AudioSection ordered text; bind to script hash; count alone is insufficient compatibility |
| voice_en, voice_hi | Narration & Alignment | AudioFile done + nonempty file, phoneVoiceoverImport and ScriptReceipt voice counts; verify section/script compatibility |
| align_en, align_hi | Narration & Alignment | alignmentService, timelineScript and alignment file; desktop-only validation; file existence needs dependency fingerprint |
| crop_json | Image Clipper | readChapterCropState, perImageStore, phoneCropImport; Android PageSections/ClipperPage validate phone page; cloud zip availability separate |
| review | Image Clipper | chapterReview.readEffectiveReview; human gate per revision; technical validator does not bypass it |
| crop | Image Clipper | chapterCrop outputs.complete + fullyAttached; processedSync; real image outputs required |
| timeline_en, timeline_hi | Editor & Export | Editor2Timeline json + editorWorkflow/store + Android EditorStages; nonempty JSON alone does not prove correct input revision |
| processed_en, processed_hi | Editor & Export | processedJson equality with current JSON, videoEditor2Service; retain input files/dependencies |
| export_en, export_hi | Editor & Export | editor2Export.listExistingExports, actual output + render result; archive/manual-complete is an override |

Storage Manager checks files/capacity/archive eligibility across stages through storageService. Cloudflare Manager validates delivery/object availability, not content quality/import. Device Fleet Manager uses relay presence/capabilities/readiness; liveness is separate from task progress. Accounts Manager adapts phoneProfiles/phoneReadiness and Android ProfileCheck, ChatGptUsage, UploadLedger, AiStudioLedger with unknown/observed/estimated labels. Issues Manager owns grouped incident lifecycle; Automation Manager owns dispatch; Manhwa Studio Manager aggregates readiness without replacing validators. This maps all 12 shared roles.

Per phone: Device Manager → Automation/AutomationService and local attempt journal (proposed); Library & Preparation → LibrarySync/NarrationLibrary; Narration → AutoRun/ScriptReceipt; Voiceover → VoiceoverRun/ScriptReceipt; Device Image Clipper Manager → ClipperRun/ClipperPage/ClipperReceipt; Editor → EditorRun/EditorStages; Accounts & Capacity → RemoteProfiles/ProfileCheck/ledgers; Sync → StudioRelay and upload/sync queues; Website UI Monitor → proposed observer around existing adapters. These are nine logical roles, not nine processes. Monitor → same-device Image Clipper Manager → Issues Manager → owner remains mandatory.

## Mechanically captured mutation route coverage

Every current Express mutation declaration under `server/src/routes` is listed below as an audit index. All follow the family classification above; unclassified paths default blocked for managed scopes. This includes maintenance/settings paths so future enrollment cannot quietly bypass a conflicting mutation.

- `server/src/routes/chapters.ts:56` — `router.post('/bulk-update', async (req: Request, res: Response) => {`
- `server/src/routes/chapters.ts:81` — `router.delete('/:id', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:403` — `router.put('/chapters/:id/images/:filename/points', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:526` — `router.put('/chapters/:id/images/:filename/metadata', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:631` — `router.put('/chapters/:id/review', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:658` — `router.post('/chapters/:id/crop', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:800` — `router.post('/series/:seriesId/slices', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:929` — `router.post('/series/:seriesId/fetch-phone-crops', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:962` — `router.post('/cropped-markers/publish', async (_req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:997` — `router.post('/series/:seriesId/sync-processed', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:1162` — `router.post('/series/:seriesId/sync-processed/preview', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:1279` — `router.post('/series/:seriesId/unsync-processed', async (req: Request, res: Response) => {`
- `server/src/routes/clipper3.ts:1396` — `router.post('/series/:seriesId/unsync-processed/preview', async (req: Request, res: Response) => {`
- `server/src/routes/downloads.ts:16` — `router.post('/queue', async (req: Request, res: Response) => {`
- `server/src/routes/downloads.ts:37` — `router.post('/pause', (req: Request, res: Response) => {`
- `server/src/routes/downloads.ts:46` — `router.post('/resume', (req: Request, res: Response) => {`
- `server/src/routes/downloads.ts:55` — `router.post('/clear', async (req: Request, res: Response) => {`
- `server/src/routes/downloads.ts:64` — `router.post('/retry-failed', async (req: Request, res: Response) => {`
- `server/src/routes/manual.ts:79` — `router.post('/series', async (req: Request, res: Response) => {`
- `server/src/routes/manual.ts:140` — `router.post('/series/:seriesId/chapters', async (req: Request, res: Response) => {`
- `server/src/routes/manual.ts:219` — `router.post(`
- `server/src/routes/manual.ts:359` — `router.delete('/series/:seriesId/chapters/:chapterNumber/files', async (req: Request, res: Response) => {`
- `server/src/routes/manual.ts:428` — `router.post('/series/:seriesId/chapters/:chapterNumber/reindex', async (req: Request, res: Response) => {`
- `server/src/routes/manual.ts:558` — `router.post('/import/all', async (req: Request, res: Response) => {`
- `server/src/routes/manual.ts:588` — `router.post('/import/series', async (req: Request, res: Response) => {`
- `server/src/routes/narration.ts:274` — `router.post('/series/:id/phone/preview', async (req: Request, res: Response) => {`
- `server/src/routes/narration.ts:298` — `router.post('/series/:id/phone/fetch', async (req: Request, res: Response) => {`
- `server/src/routes/narration.ts:339` — `router.post('/chapters/:id/script/replace', async (req: Request, res: Response) => {`
- `server/src/routes/narration.ts:371` — `router.post('/chapters/:id/alignment-sections/:sectionId/reset', async (req: Request, res: Response) => {`
- `server/src/routes/narration.ts:400` — `router.post('/chapters/:id/align', async (req: Request, res: Response) => {`
- `server/src/routes/pagePreview.ts:64` — `router.post('/chapters/:id/delete', async (req: Request, res: Response) => {`
- `server/src/routes/pagePreview.ts:74` — `router.post('/chapters/:id/restore', async (req: Request, res: Response) => {`
- `server/src/routes/pagePreview.ts:84` — `router.delete('/chapters/:id/bin', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:106` — `router.put('/config', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:130` — `router.post('/test', async (_req: Request, res: Response) => {`
- `server/src/routes/r2.ts:189` — `router.post('/phone/request', async (_req: Request, res: Response) => {`
- `server/src/routes/r2.ts:198` — `router.post('/phone/automation', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:226` — `router.post('/phone/automation/plan', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:255` — `router.post('/phone/readiness/fix', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:286` — `router.delete('/phone/screens/:device/screenshot', (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:290` — `router.post('/phone/profile', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:303` — `router.post('/phone/screen', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:316` — `router.post('/phone/forget', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:332` — `router.put('/relay', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:346` — `router.post('/relay/test', async (_req: Request, res: Response) => {`
- `server/src/routes/r2.ts:354` — `router.delete('/objects', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:374` — `router.post('/phone-send', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:392` — `router.put('/phone-send/auto', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:403` — `router.post('/phone-send/index', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:422` — `router.post('/phone-pull', async (req: Request, res: Response) => {`
- `server/src/routes/r2.ts:440` — `router.post('/cancel', async (_req: Request, res: Response) => {`
- `server/src/routes/series.ts:27` — `router.post('/:id/automation', async (req, res) => {`
- `server/src/routes/series.ts:31` — `router.post('/:id/automation/stop', async (req, res) => {`
- `server/src/routes/series.ts:122` — `router.post('/infer-pattern', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:162` — `router.post('/validate-pattern', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:190` — `router.post('/discover-chapters', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:240` — `router.post('/', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:319` — `router.post('/:id/delete-everywhere', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:330` — `router.put('/:id/parts/:part/completion', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:345` — `router.delete('/:id', async (req: Request, res: Response) => {`
- `server/src/routes/series.ts:359` — `router.post('/:id/chapters', async (req: Request, res: Response) => {`
- `server/src/routes/settings.ts:47` — `router.put('/:key', async (req: Request, res: Response) => {`
- `server/src/routes/settings.ts:70` — `router.put('/', async (req: Request, res: Response) => {`
- `server/src/routes/settings.ts:96` — `router.post('/reset', async (req: Request, res: Response) => {`
- `server/src/routes/settings.ts:107` — `router.post('/open-folder', (req: Request, res: Response) => {`
- `server/src/routes/stitch.ts:194` — `router.post('/chapters/:id', async (req: Request, res: Response) => {`
- `server/src/routes/stitch.ts:209` — `router.post('/chapters/:id/undo', async (req: Request, res: Response) => {`
- `server/src/routes/stitch.ts:220` — `router.delete('/chapters/:id/backup', async (req: Request, res: Response) => {`
- `server/src/routes/storage.ts:97` — `router.post('/chapters/:id/delete', async (req: Request, res: Response) => {`
- `server/src/routes/storage.ts:109` — `router.post('/series/:id/delete', async (req: Request, res: Response) => {`
- `server/src/routes/storage.ts:121` — `router.delete('/series/:id/videos/:dir/:file', async (req: Request, res: Response) => {`
- `server/src/routes/storage.ts:134` — `router.delete('/series/:id/videos/:dir', async (req: Request, res: Response) => {`
- `server/src/routes/storage.ts:142` — `router.post('/series/:id/parts/:part/working-files', async (req: Request, res: Response) => {`
- `server/src/routes/storage.ts:161` — `router.post('/series/:id/parts/:part/complete', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:50` — `router.post('/chapters/:id/staged-timeline', async (req, res) => {`
- `server/src/routes/videoEditor2.ts:142` — `router.post('/chapters/:id/process-timeline', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:218` — `router.put('/chapters/:id/timeline', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:322` — `router.post('/series/:seriesId/check-image-refs', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:359` — `router.put('/prompt', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:380` — `router.post('/series/:seriesId/send-to-phone', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:404` — `router.post('/series/:seriesId/fetch-phone-timelines', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:445` — `router.post('/series/:seriesId/export-all', async (req: Request, res: Response) => {`
- `server/src/routes/videoEditor2.ts:505` — `router.post('/exports/:jobId/cancel', (req: Request, res: Response) => {`
