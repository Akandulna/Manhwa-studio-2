# AntiGravity: operations guide

This guide covers how an AntiGravity Image Clipper run works on this Mac, what to do when something goes wrong, and where everything is stored. Setup is covered in [antigravity-google-drive-setup.md](antigravity-google-drive-setup.md) and the CLI evidence in [antigravity-compatibility-report.md](antigravity-compatibility-report.md).

## What a run does

For each selected page (**AntiGravity → Series → Part → Image Clipper**):

1. **Prepare.** Studio cuts the original page into full-width **2000 px** slices of lossless WebP. Each slice is checked to decode to exactly the original pixels of its region. Nothing is resized, rotated or trimmed. Pages wider than 2000 px are refused.
2. **Upload.** The slices, `handoff.json`, the rendered `crop-prompt.txt` and the `review-prompt.txt` template go to `My Drive / Manhwa Studio / <Series> / Chapters / <Exact Chapter Folder> / <page>__<hash>/`. Every file's Drive ID is reserved before the upload, and its SHA-256 is checked against Drive's own checksum.
3. **Analysis turn.** Studio starts `agy` with the pinned model in a private workspace for this attempt: `~/Library/Application Support/Manhwa Studio/antigravity/attempts/<id>/`. The prompt is the phone's Crop Rules plus the Crop Pointer prompt, plus a short Studio note on how images arrive.
   - The model fetches every slice through Studio's MCP tool `fetch_slice`.
   - It submits its JSON through `submit_analysis`.
   - Studio validates the JSON with the phone's rules. If it fails, the model gets the problems and fixes them in the same turn.
   - If a turn ends without a submission (for example, the model tried a shell command, which is refused and ends the turn in `agy`'s print mode), Studio continues **the same conversation** up to 2 times, telling the model that commands aren't available. Review turns get the same treatment.
4. **Review turns.** Studio sends the phone's Review prompt into **the same conversation**, by its stored ID. The prompt includes the automatic checks and the sweep of uncovered inked areas, computed on the original page. The model replies through `submit_review`. If checks remain open, Studio sends up to **2 more** review rounds, then marks the page **Needs attention**.
5. **Validate and import.** Studio converts slice-local corners to normalized coordinates on the original page and writes `crop_points3/<page>.json` (`clipper-geometry/1`) through Clipper's normal store. The page shows **Done** in Clipper 3.0, but **human review and Crop Sections are still yours**: AntiGravity never approves, cuts or writes Metadata.

Only results submitted through Studio's tools count. The CLI's exit code or a reply saying "done" proves nothing.

6. **Share with phones.** Studio writes the page into the phones' own shared folder in R2: `<prefix>shared/crops/<Series>/<Chapter>/<page>.page.json`, the same format a phone uses when it finishes a page. On their next sync, phones take it like a page another phone finished, so it shows as done and Auto-run skips it. Studio asks the phones to sync once per finished run, through the relay if it's set up. Two exceptions:
   - If a phone already shared that page, the phone's work is kept and Studio doesn't overwrite it.
   - If a series restart is still synchronizing, Studio refuses to share.

**Fetch finished pages** (Image Clipper screen) does the reverse, on demand: it reads the pages phones shared for this part and imports their geometry pointers into Clipper, so they show as done here. It costs 1 R2 list per series plus 1 read per new or changed page, and never runs on a timer. Saved pointers are never replaced. Legacy pages that carry metadata are left to **Sync json**.

## Page stages

| Stage | Meaning | What to do |
| --- | --- | --- |
| Selected / Slicing / Uploading | Preparation is running. | — |
| Prepared | Inputs are verified in Drive. | Start process. |
| Queued / Analyzing / AI review / Validating / Importing | AI work or import is running. | — |
| Ready for human review | Pointers are imported as candidates. | Open **Preview in Clipper**, correct, approve, then Crop Sections. |
| Needs attention | Review is unresolved after the correction budget, a tool was refused, or saved pointers appeared meanwhile (conflict). | Read the error. **Retry** starts a new attempt from the prepared inputs. |
| Failed | A specific error, shown on the page. | Fix the cause, then **Retry**. |
| Stale | The source page changed after selection. | Select the page again. |
| Stopped / Interrupted | You stopped the run, or Studio quit while the page was running. | **Retry**. Nothing is resumed or resent on its own. |
| Rejected | You rejected the result, here or with Clipper's **Reject** ("Rejected in Clipper"). Its pointers were backed up and removed, and phones were told it is void. | **Process again**, or tick the page and **Start process**. A phone can also redo it. |

## Controls

- **Pause:** no new pages start. Pages already in progress finish their analysis, review and import.
- **Resume:** continues the same run.
- **Stop:** Studio does four things:
  - cancels queued pages;
  - revokes the MCP permission of in-flight attempts, so a late submission can't be committed;
  - stops only the `agy` processes Studio started;
  - keeps Drive uploads and earlier results.
- **Retry:** there are three cases.
  - **Imported · R2 pending:** only the sharing with phones is retried.
  - **A validated result that failed to import:** only the import is retried.
  - **Anything else:** a new attempt (a new conversation) starts from the prepared Drive inputs.

  The first two never make an AI request.
- **Review again** (Needs attention or Interrupted, after an accepted analysis): Studio runs more review rounds in **the same conversation**, on the same model, with a fresh one-attempt permission. There is no new analysis.
- **Reject** (Ready for human review, or Imported · R2 pending): for a result that isn't acceptable. It's on the run page and on each page row in Image Clipper. You can add a note about what was wrong; it is kept in the run's log and is not sent to the model.
  - It uses Clipper's own **Reject**. The page's pointers, any crops rendered from them, and the chapter's review marker are backed up under `.studio-page-redo/backups/`, then removed. A redo request goes to R2 (`shared/studio-page-redo/…`), and phones clear their copy of the page.
  - No phone is asked to start the redo automatically.
  - **Reject & process again** starts a new attempt in a new conversation at once, reusing the prepared Drive slices. **Reject only** leaves the page Rejected: **Process again** later, or run it on a phone.
  - The next result names the rejection it replaces (`studioRedoRevision`), as a phone's redo does. Phones take it over the void result, and it may replace a phone's page made before the rejection. A phone page made for the same rejection still wins.
  - If the page's pointers were edited after the result (in Clipper Preview, say), Reject is refused. Use Clipper's own Reject there.
- **Automatic pause:** if `agy` reports that the account or model quota is used up, that it isn't signed in, or that the pinned model is gone, Studio pauses the run instead of trying every remaining page. The reason appears at the top of the run page. Fix the cause, then **Resume**.

## Protection rules

- Pages with saved pointers can't be selected. To regenerate one, use **Reject** (AntiGravity) or Clipper's explicit redo; the import then finishes that redo.
- **Fetch finished pages** never brings a rejected result back. While a page's rejection is open, it takes only a result made for that rejection.
- If pointers appear on a page while its job runs, the newer saved work wins. The AI result is kept as history only, and the page is marked as a conflict.
- Managed pages and chapters already human-reviewed in Studio are never written.
- Quitting Studio stops its own `agy` processes, and only those. After a crash, Studio's next start stops any `agy` process an unfinished attempt left running, after checking that the process is still `agy`. Unfinished pages show as **Interrupted** until you retry them or review them again.
- **One worker per page.** A page that another run is working on, with any model, is shown as that run's job instead of being started twice. Selecting a page again after its pointers were removed starts a new attempt and reuses its prepared Drive inputs.
- A page whose chapter is having pages replaced, or whose series restart is still syncing, isn't processed. It shows **Needs attention**; retry once Library has finished.

## Limits and quota

- Model requests use your Antigravity account's quota. Running pages in parallel doesn't add quota.
- **Parallel pages:** the default is 1; 2 is available. Each page has its own conversation, workspace and permission, and analysis and review within a conversation never overlap. The limit counts every run on this Mac together.
- Preparation (slicing and Drive uploads) uses its own pool of 2, separate from the AI slots.
- 3–4 stay locked until a live 2-page run has been checked.
- The page deadline is 45 minutes, including review.
- Drive API calls are currently free within Google's quotas; the slices use your Drive storage.

## Where things are

| Item | Location |
| --- | --- |
| Run, page job, attempt and event records | Studio database: `AntigravityRun`, `AntigravityPageJob`, `AntigravityAttempt`, `AntigravityEvent`, `DriveInputFile` |
| Prompt versions | `AntigravityPromptVersion`; the current one per kind is in the Setting `antigravityPromptCurrent` |
| Attempt workspaces (MCP config with a one-attempt token) | `~/Library/Application Support/Manhwa Studio/antigravity/attempts/` |
| Uploaded inputs | Your Drive, under `Manhwa Studio/`. Studio never cleans these up automatically. |
| Conversations | Antigravity's own history (`~/.gemini/antigravity-cli/`) |

## Run evidence

The run page's event log records the following for each page:
- every stage and every `agy` turn, with its duration and conversation ID;
- every same-conversation follow-up;
- each share with phones;
- the attempt's **tools used**, read from its own conversation transcript:
  - Studio's tools, with counts;
  - the CLI reading its own image or tool files (expected);
  - anything else, flagged **UNEXPECTED** (for example a shell command, another MCP server, or a file outside the CLI's own folders).

The run page never shows tokens or Drive file contents. Conversations stay in Antigravity's own history: `~/.gemini/antigravity-cli/brain/<conversation>/`.

## Database changes (additive)

AntiGravity added tables only. No existing table or column was changed. This repo applies schema changes with `prisma db push` (`npm run db:push`). Each change was applied after a full copy of the database:

| Change | Tables | Backup on this Mac |
| --- | --- | --- |
| Google Drive (Phase 1) | `DriveOAuthClient`, `DriveConnection`, `DriveFolderMapping` | `server/prisma/dev.db.pre-antigravity-drive-20261107-031638.bak` |
| Jobs (Phase 4) | `AntigravityPromptVersion`, `AntigravityRun`, `AntigravityPageJob`, `AntigravityAttempt`, `DriveInputFile`, `AntigravityEvent` | `server/prisma/dev.db.pre-antigravity-jobs-20261107-051650.bak` |
| Delivery (Phase 5) | `AntigravityDelivery` | `server/prisma/dev.db.pre-antigravity-delivery-20261107-104636.bak` |

To apply the same schema on another Mac:

1. Quit Studio.
2. Copy `server/prisma/dev.db` somewhere safe.
3. Run `cd server && npm run db:push`.

Never use `--force-reset` or `--accept-data-loss`. If Prisma says data would be lost, stop: the schema on that Mac differs, so compare before going further.

These Setting keys are non-secret:
- `antigravitySettings`
- `antigravityCompatibility`
- `antigravityPromptCurrent`
- `antigravitySharedSeen:<seriesId>`, the ETags of shared pages already read by Fetch.

Secrets are kept in the macOS Keychain only (service "Manhwa Studio · Google Drive").

