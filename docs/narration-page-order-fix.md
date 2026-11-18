# Narration page-order and readability fix

## Current policy — whole pages and shorter scripts (2026-11-11)

The user requested whole pages to reduce generation time. This supersedes the short-piece preparation described
in the historical investigation below. Studio and Sleeper-Cell now prepare exactly one labelled upload per original
page, including tall stitched pages. They keep page IDs, random check codes, ordered notes, printed-text evidence
and all review stages. Oversized pages are resized as a whole to fit the image transport bounds, including the
identity band; no source rows are cut or omitted. A 17-page chapter needs four batches of five-or-fewer pages,
instead of the previously observed 139 pieces / 28 batches. Source page files remain unchanged.

Spoken scripts now target **40% fewer words**. Studio rewrites use 60% of the existing script word count as their
checked ceiling; fresh Studio chapters and Sleeper-Cell use 60% of the accepted draft word count. The ceiling is
fixed at the draft checkpoint and enforced in both image review and the final spoken check. Summaries and overview
text do not count toward it. Prompts preserve key events, dialogue meaning and ordered image coverage while
combining routine actions and removing filler. Hinglish inherits the shorter English source without a second 40%
cut. Manual copyable English prompts request the same draft reduction; Hinglish prompts use that saved English.

The phone's prompt-library migration (database version 11) refreshes Script and Hinglish defaults and saves the
previous prompt text in history. Existing saved scripts and audio are not regenerated automatically. Continue on
an older split-page Studio attempt asks for Retry, which prepares whole pages with a fresh attempt.

Validation of this policy: 54 focused Studio tests passed across narration integration/unit, replacement, manual
prompts, readiness, run scoping and client transport checks. The 12,000-row whole-page test uses a 20-second
timeout after exceeding the old 5-second allowance while Android and both TypeScript builds ran concurrently;
its focused rerun passed in 1.3 seconds. Server and client builds passed. Android offline Debug and Beta suites
each passed 1,106 tests, and the AI Studio DOM/script checks passed. Built
`1.0.230-beta.20261111-whole-pages-compact` (`com.sleepercell.browser.beta`); subsequently installed and verified
on Nord and Note 10 Pro with their existing app data retained.
No live chapter generation was started during this update, so whole-page model reading and actual video duration
remain unverified. A word-count reduction does not guarantee exactly the same percentage reduction in audio duration.

## Parallel notes conversations (2026-11-11)

Studio now reads independent notes batches concurrently, up to the process's pinned **Parallel conversations**
setting (1–4, in AntiGravity settings). Each batch still reads at most five whole pages. With 17 pages and a limit
of four, all four notes conversations can run together. Studio then combines their accepted notes in original
page order before starting one writing conversation for draft → image review → final spoken check. Chapters
remain sequential so their saved summaries and closing paragraphs provide continuity.

Each notes batch has its own persisted attempt, isolated workspace, token, conversation ID, delivered-page set,
submission budget and error state. Notes tools can fetch/submit only their assigned pages; they cannot draft or
review the chapter. Checkpoint merges are serialized per chapter attempt so simultaneous completions do not lose
notes. Continue reuses an unfinished batch's exact conversation and skips accepted batches. Stop revokes the
parent capability and cancels all workers; restart recovery also records each unfinished worker as interrupted.
The run log identifies each batch and records its conversation. No database schema migration is needed.

Validated with model doubles for Antigravity, Claude and Codex: four overlapping conversations with out-of-order
completion; the one-conversation setting; cross-batch/tool rejection; stop/late calls; quota pause; input changes;
and recovery with accepted notes preserved. Live provider throughput has not been benchmarked.

Validation: 30 narration integration cases across the three engines, 70 focused narration/adapter/replacement
regressions, and 29 existing runner/Metadata/Editor integration cases passed (129 total). Server and client builds
passed, and the Apple Silicon desktop app was packaged and ad-hoc signature verified under
`desktop/dist/mac-arm64/Manhwa Studio.app`. This parallel-notes change is Studio-only; the previously installed
phone beta is unchanged.

## Historical investigation

## What went wrong (I Became a Cheat-Level Skill Thief, chapter 1)

The phone wrote chapter 1 from its 17 stitched pages (709 × ~12,000 px each) in batches of five.
The saved notes (`script.review.json`) describe the real pages in this order:

| Batch | Real pages | Order the notes describe them |
|---|---|---|
| 1 | 1–5 | 2, 4, 1, 3, 5 |
| 2 | 6–10 | 6, 9, 8, 7, 10 |
| 3 | 11–15 | 13, 12, 14, 15, 11 |
| 4 | 16–17 | 16, 17 |

Batch 1 was confirmed by opening the files; batches 2–4 were matched from the note descriptions.

Two causes:

1. **Order.** Five files go to AI Studio in one file-chooser call. The prompt said "attachment 1 is page 1" and
   asked the model to match by filename, which it cannot see. The app only checked that five chips loaded and that
   the reply echoed the page ids in order, which it does whatever it actually saw.
2. **Readability.** A 709 × 12,000 px strip is shrunk to a small image, so speech bubbles are unreadable. The model
   followed the artwork and invented names (Alicia, Maria, Lucifer) instead of the captions (Abella, Mary Diana,
   Sigrin Efania).

## Fix

### Sleeper-Cell (phone)

- **Short pieces.** `PageFit` cuts every page taller than 2,600 px into ~2,000 px pieces at blank rows.
- **Label band.** Every uploaded piece gets a white band on top: `P0003-T002 · CHECK K7QM`. The check code is random
  per run and is never written in the prompt, so the model can only report it by reading that image.
- **One file at a time.** Each file is attached and finishes loading before the next.
- **Notes keyed by label.** The notes reply carries `id` and `check` read from each band. The app matches them to
  the pieces, rejects a wrong or missing code, and sorts the notes itself. Position no longer matters.
- **Verbatim text.** Each note carries `text`: captions and dialogue copied word for word.
- **Name check.** A capitalised name in the final script must appear in the quoted page text or in the prompt's
  earlier summary/overview. Otherwise the review gets one correction, then the chapter stops.
- **Audit.** `script.review.json` keeps the check codes, the quoted text and the attach order.

### Manhwa Studio (AntiGravity)

- **Narration scripts** becomes an AntiGravity process (Workflow card), English first.
- Studio cuts and labels pieces the same way. The model fetches each piece **by id** through an MCP tool, so there is
  no upload order. Notes are refused until every piece in the batch was opened.
- Same four stages as the phone: notes → draft → image review → spoken-narration check.
- Chapters run in order, one at a time per series (each needs the previous summary and closing).
- Save = the existing script replacement path (backup, reset audio/alignment/timeline, send to phones).

### Finding affected scripts

A check-only run compares each chapter's saved notes with its pages and lists failures. Rewriting is chosen per
chapter, because a new script needs a new voiceover and timeline.

## Costs

- A 17-page chapter becomes about 100 pieces: about 20 note turns instead of 4.
- Sequential attach is slower than one batch attach.

## Status (2026-11-11)

### Built

- **Phone** (Sleeper-cell-main, branch v2, uncommitted): `PageFit.kt` (blank-row cuts of ~2,000 px, label band,
  check codes), `NarrationImage.kt` (`check`, `band`), `NarrationSequence.kt` (band-based notes, `text`, name check,
  audit), `NarrationImageBatches.kt` (prompt passed to the review checks), `AutoRun.kt` (one file per chooser).
  Full phone unit suite: 1,107 tests, 0 failures.
- **Studio**: AntiGravity kind `narration`.
  - `server/src/services/antigravity/narrationPieces.ts`: cuts and labels pieces with sharp. Desktop pieces are
    1,600 px, max 1,900, so a piece with its band stays under the 2,000 px agy shows unscaled.
  - `narrationFlow.ts`: prompts, tools and checks.
  - `narrationStudio.ts`: inputs and save. The save goes through `replaceChapterScript`, which now takes
    `generated: { summary, about }`, writes `script.review.json` and records the model on `ChapterScript`.
  - Job runner: `jobs.ts` Narration section.
  - Routes: `POST /antigravity/narration/status`.
  - Screen: `client/src/pages/antigravity/AntiGravityNarration.tsx`; the Workflow card is now active.
- **Tests**: `narration.test.ts` (10), `narration.integration.test.ts` (2, fake agy giving notes in reverse order),
  one `scriptReplacement` case. The AntiGravity suite passes (158 tests), and the two stale Workflow screen tests were
  updated. The full server suite still has 4 failures: 3 managed-handoff tests and `orderRuns`.

### Design notes

- **One conversation per notes batch.** In AntiGravity, each batch of 5 pieces gets its own conversation. A whole
  chapter's images in one conversation would be about 190k tokens on Claude.
- **Draft, review and check share one conversation.** Any piece can be fetched again during them.
- **Chapters are written one at a time, in chapter order.** A later chapter waits until the earlier chapter's job is
  done.
- **Start process only writes chapters without a script.** Ticking a chapter rewrites it (backup; English voiceover,
  alignment and timeline reset; Hindi untouched).

### Not done yet

- **Phone APK.** The new phone code isn't built or installed on either phone.
- **Live pilot.** No live pilot on a real chapter in AntiGravity, and Phase 0 (the scrambled-order test in AI Studio)
  was not run.
- **Narration claims.** Phones can still write a chapter that AntiGravity Narration is writing. The save refuses to
  overwrite a script that changed meanwhile, so nothing is lost.
- **Check-only run.** The run that finds already-wrong scripts isn't built.
- **Manual prompts.** The "Continue manually" prompts still ask the user to attach pages in order (the user can see
  the order there).

### Claude narration continuation (2026-11-11)

- Added Claude Code to the narration integration fixture. Both engines now exercise notes → draft → review →
  spoken check, separate notes conversations, one shared writing conversation, chapter continuity, rewrites,
  wrong check codes, invented names, and continuation with accepted notes preserved.
- Fixed a delivery-record race: parallel `fetch_piece` calls could each read the same checkpoint and overwrite
  one another's delivered IDs. Narration bridge calls now queue per capability and reload the active attempt
  inside the queue, preserving all delivered IDs and checking revocation before handling a queued request.
- Added regressions for parallel fetching and matching check codes submitted without fetching the images.
  The parallel-fetch test failed before the fix and passes for both Claude and Antigravity afterward.
- Temporary SQLite files are created before Prisma initializes the integration fixtures. Test-server bind errors
  are surfaced immediately in the narration fixture. Corrected a TypeScript error in the missing-check-code test.
- Focused validation: 46 tests passed (10 narration integration, 10 narration unit, 17 Claude adapter, 9 script
  replacement). Server TypeScript and client production builds passed. These tests use model doubles and an
  in-memory save adapter; a real Claude chapter pilot and phone delivery are still unverified.
- Broader regression checks: 148 tests passed across AntiGravity, manual narration, script replacement and the
  affected client suite, including 29 existing integration cases rerun after fixing their SQLite setup. The
  previously documented client `orderRuns is not a function` failure remains. The full server suite was not rerun.

## Keep finished work, stall stop, agy only (2026-11-11)

- **Retry and Stop keep finished work.**
  - A new attempt takes over the newest unfinished attempt's accepted notes, draft, image review and word limit,
    when the chapter's inputs (pages, script, previous summary) and page preparation (`narrationPieces.PREPARATION`)
    are unchanged and its page images are still on disk. Only the remaining stages run, in new conversations.
  - **Start over** (Narration page, or `POST /antigravity/jobs/:id/retry {fresh:true}`) reads every page again.
  - Continue now also works for Failed and Stopped chapters.
  - A writing turn that times out or stalls ends in Needs attention.
- **Stall stop.** A Narration turn is stopped when its agent makes no Studio tool call and its agy transcript doesn't
  change for 10 minutes (`NARRATION_STALL_MS`). 25 real agy transcripts showed gaps of at most ~5 minutes between
  steps. A stalled turn gets one more turn in its conversation; a second stall leaves the chapter in Needs attention,
  and Continue picks it up there. This applies to Narration only, including its notes conversations.
- **agy only.** Narration refuses ChatGPT (Codex) and Claude (`NARRATION_ENGINES`; Gemini CLI to be added). The
  Narration page shows a warning when another engine is selected.
- **Whole pages on agy are not proven.** agy shows images at most 2,000 px a side (354 stored images checked), so a
  709 × 12,000 page reaches the model at about 118 px wide. The user is testing this once before deciding.
- **Tests.**
  - Narration integration tests run on agy only (17): ChatGPT and Claude are refused, Retry keeps notes and draft,
    Start over, Continue after a failure, stall then continue, and stall twice then Continue.
  - The AntiGravity suite and related Studio tests pass (191). The only failure is the earlier `orderRuns` screen
    test.

## agy pieces of at most 2,000 px (2026-11-12)

After testing, the user confirmed that agy needs cut pages. Studio Narration now cuts every page at blank rows into
pieces whose art plus label band is at most 2,000 px tall (`narrationPieces.AGY_MAX_SIDE`; up to ~1,936 px of art at
709 px wide). A page wider than 2,000 px is first scaled to 2,000 px wide. Every source row goes into exactly one
piece, and source files are unchanged. `PREPARATION` is now `agy-pieces-2000/1`: whole-page attempts are not taken
over by Retry, and Continue on one asks for Retry or Start over. Notes still go five pieces per conversation, with the
run's parallel limit. Sleeper-Cell was switched back to ~2,000 px pieces separately on 2026-11-12 (beta 1.0.231 on both phones), after its whole-page run on AI Studio got every check code wrong. Tests: the AntiGravity suite plus
replacement, 169 passed. The integration data now cuts a 5,000 px page into three pieces at its gutters.

## Batches of 10 (2026-11-12)

Every piece is identified by the id and check code on its band, so batch order no longer protects anything and the
batch size was raised from 5 to 10 everywhere: AntiGravity notes conversations (`narrationFlow.BATCH_SIZE`), the
manual prompts (`MANUAL_BATCH_SIZE`; 10 is the Gemini app's per-prompt file limit) and Sleeper-Cell's AI Studio run
(`NarrationImageBatches.SIZE`), which now also attaches a batch's files through one file chooser instead of one each.
Two fixes went with it:

- **Notes conversations remember their pieces.** A notes task now stores `pieceIds`; Continue reuses an unfinished
  notes conversation only when it was made for exactly the same pieces. Older tasks (batches of 5) carry no ids, so
  they are set aside and their batch is read in a new conversation; accepted notes are kept per piece.
- **Any argument name is accepted.** Up to 2026-11-12 only 16 of 131 agy `submit_notes` calls used the documented
  `json` argument, and the rest were refused with "Return one JSON object" (only 8 of 27 batches passed on the first
  submission). `submittedText` now takes `json`/`text`, the arguments themselves when they are the object (`pieces`,
  `paragraphs`), or the one non-empty value; the prompts and tool descriptions name the argument.
