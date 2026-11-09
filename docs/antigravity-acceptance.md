# AntiGravity acceptance trace (final, 2026-11-07)

This file tracks PRD §21 and §22. Every status uses one of five labels:

- **Verified live:** checked against your real accounts, library, Antigravity CLI, R2 and phone.
- **Implemented + tested:** built and covered by automated tests with simulated providers. These tests prove the orchestration, not the model's ability.
- **Partial:** some of the behaviour is in place.
- **Pending (manual):** a live check that hasn't been done.
- **Not started:** nothing built yet.

Related documents:
- [setup guide](antigravity-google-drive-setup.md)
- [operations guide](antigravity-operations.md) (it also lists the database changes)
- [CLI compatibility report](antigravity-compatibility-report.md)

## Decisions that change the PRD

| PRD | What was built | Decided by |
| --- | --- | --- |
| §8.2: 2048 px slices | **2000 px** slices for AntiGravity only, because the CLI scales Gemini images above 2000 px. Clipper 3.0 keeps 2048 px. Pages wider than 2000 px are refused. | Operator, Phase 4 |
| §9.1: prompt pack | The phone's **geometry-only Classic path** from Sleeper-Cell v2, ported and byte-checked against Kotlin. **Crop Rules + Crop Pointer** prompt for analysis. **Review prompt** without Crop Rules, plus the automatic checks. | Operator, Phase 2 |
| §1.2: correction budget | 2 review correction turns, against the phone's 5. Up to 2 extra follow-ups in the same conversation when a turn ends without a submission. The CLI's print mode ends a turn on any refused action. | PRD and live finding |
| §14.2 / §14.5: R2 namespace and phone treatment | Results go into the phones' own `shared/crops/<Series>/<Chapter>/<stem>.page.json` (`sleeper-cell-shared-page/1`). Phones mark the page **done**, like a page another phone finished, and Auto-run skips it. Phone-finished pages are imported into Studio by **Fetch finished pages**. There is no separate index or catalog. In Studio, human review, cutting and Metadata stay manual. | Operator, Phase 5 |
| Page-level Reject (addition) | A finished result can be rejected from the run page or the page list. It reuses Clipper's explicit page rejection (backup, removal, R2 redo request with no phone chosen). **Reject & run again** starts a new attempt and conversation. The replacement carries `studioRedoRevision`, so phones accept it, and Fetch never takes the rejected result back. | Operator, after Phase 7 |
| §5.4: tools | Allow-only `mcp(studio/*)` plus `--sandbox`. Each attempt's **tools used** are recorded from its transcript, and anything unexpected is flagged. | Operator, Phase 2 |

## Requirements

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| AG-01 | Drive is the first complete milestone | **Verified live** | Phase 1 was live-tested before any processing runner existed (see below). |
| AG-02 | OAuth uses the intended account; no secrets exposed | **Verified live** (consent, identity), **Implemented + tested** (forged state, denied consent, invalid grant, redaction) | `abhishekkandulna14@gmail.com` connected with scopes `openid`, `userinfo.email` and `drive.file`. Log, Settings and DriveConnection rows hold 0 token-shaped strings. 27 tests in `googleDrive.test.ts`. |
| AG-03 | Empty Drive gets the hierarchy automatically | **Verified live** | Root `1rK3530R_FxR2qee1a7b0dxf1XvG8ds3F`, then series, `Chapters`, `Chapter 021`, and 8 page folders `<stem>__<sha12>`. Each folder kind has exactly one mapping, with no duplicate folder IDs. |
| AG-04 | Repeated preparation is idempotent | **Implemented + tested**, live gap found and fixed | Folders and lost-response uploads are reconciled by pre-generated ID (tested). **Live finding:** pages 005–008 were prepared under one model and then run under another, and 24 slice files were uploaded twice because job identity includes the model. **Fix:** a verified file with the same bytes and name in the same page folder is now shared (`drivePackage.ts`; integration test "reuses the verified Drive slices"). The 24 earlier copies stay in Drive and are harmless. Nothing in Drive is deleted unless you ask. |
| AG-05 | Lossless pixels across slicing | **Implemented + tested**, checked on a real page | Each slice decodes to exactly its original pixels. Tested on short pages, exact multiples, a short final slice and a too-wide page. A real 800×10343 page gave 6 slices. |
| AG-06 | Series → Part → Workflow → Clipper navigation | **Implemented + tested**, checked on the real library | `tests/client/antigravityScreens.test.tsx`, plus a browser walk through 7 series. |
| AG-07 | Only Image Clipper is active | **Implemented + tested** | 4 `aria-disabled` Coming Soon nodes. |
| AG-08 | Page status agrees with Clipper 3.0 | **Implemented + tested**, checked live | Reads the same Clipper 3.0 endpoints. Imported pages show as Done in both views. Done, managed and too-wide pages can't be selected. |
| AG-09 | Official local CLI with model evidence | **Verified live** | `agy` 1.5.2. Each attempt records the requested model and the CLI version. The served model isn't reported by the CLI, so it's recorded as `unknown`. |
| AG-10 | Images really reach Antigravity through MCP | **Verified live** on 9 real pages | Every attempt's record shows each slice fetched through `fetch_slice` before analysis was accepted. The compatibility test also checks an image-only code. |
| AG-11 | Review is a separate turn in the original conversation | **Verified live** | Each page has 1 conversation (for example `f6b98225…`, `c18f7e81…`). Review turns used `--conversation <id>`, and the bridge refuses a different conversation. |
| AG-12 | Coordinates refer to the original page | **Implemented + tested**, checked live | Seam-spanning, bounds, whole-pixel, reading-order and cross-page cases are tested. `page_004`'s crops were drawn on the original page and sit on the right shots. One crop edge was 95 px off, which is a model-quality issue left for human review. |
| AG-13 | AI review never fabricates approval or cropping | **Implemented + tested** | Import writes only `crop_points3` (`clipper-geometry/1`). The chapter stays unreviewed and uncropped, with no Metadata. The phone counting a page done is the operator's Phase 5 decision; it isn't approval in Studio. |
| AG-14 | R2 holds verifiable JSON | **Verified live** | 8 deliveries are `published`, each read back by SHA-256. Writes use If-None-Match, or If-Match on Studio's own copy. A phone's page is never overwritten. `publication.test.ts`. |
| AG-15 | Studio and phones collect matching pages | **Verified live** (Studio to phone); **Implemented + tested** (phone to Studio) | The phone's own code accepts a real Studio page (`StudioAntigravitySharedPageTest`, JVM). The operator confirmed the phone shows the shared page as done. **Fetch finished pages** is covered by tests only. |
| AG-16 | Parallel pages have isolated conversations and outputs | **Verified live** + **Implemented + tested** | Live run `e0864358` (Gemini 4 Argon Medium, 2 at a time):<br>• pages 005 and 006 both started at 11:55:26;<br>• 005 finished at 11:59:17 and 007 took its slot while 006 was still running;<br>• 4 different conversations, all ready and published.<br>The integration test covers 3 pages over 2 chapters, 2 at a time, plus a seam page. |
| AG-17 | Stop and stale guards reject late results | **Implemented + tested**; live Stop **Pending (manual)** | After Stop: cancelled, no import, no publication, and a late tool call is refused. A commit check runs before import. A changed source becomes Stale. Chapters with a page replacement or series restart in progress aren't processed. |
| AG-18 | Restart and retry keep finished work and avoid double dispatch | **Implemented + tested**; live restart and crash drills **Pending (manual)** | Retrying publication makes no AI call (counted). Review again uses the same conversation. One owner per page across runs. A quota, sign-in or model error pauses the run. Shutdown and the next start stop only Studio's own `agy` (pid checked). Re-selecting a finished page now really runs it again; this bug was found and fixed. |
| AG-19 | Existing phone, managed and manual geometry is protected | **Implemented + tested** | Conflicts with saved pointers, managed pages and Studio-reviewed chapters are refused. A pending explicit redo is finished by the import. Fetch never replaces saved pointers. A phone's shared page is never overwritten. |
| AG-20 | Existing behavior still works | **Implemented + tested** (see the regression results below) | Full server suite, both builds and the phone's full offline unit suite. |

## Regression results (§22.2)

| Check | Result |
| --- | --- |
| `npm --prefix server run build` | ✅ clean |
| `npm --prefix client run build` | ✅ clean (the usual Vite chunk-size warning) |
| Server and client type-checks | ✅ clean |
| Full server suite (`vitest run`, 156 files, 2,178 tests, including client tests), 3 runs | ✅ 2,175 pass. **Baseline, not AntiGravity:** 3 managed-automation tests (`tests/accountHandoff`, `productionCandidateHandoff`, `recoveryDisposition`) fail because their fixtures under `/tmp/...` don't exist on this Mac. `wifiStatus.test.ts` failed once in 3 runs under load and passes alone (11/11); it's untouched by this work. |
| PRD-named suites: `cloudClipper`, `metadataSplit`, `chapterReview`, `chapterCrop`, `pageRedoRoutes`, `phoneCropImport`, `clipperParts` | ✅ all pass, inside the full suite |
| AntiGravity, Drive and screen suites (pipeline, review port, cli, publication, toolUse, jobs integration, googleDrive, antigravityScreens) | ✅ all pass. The integration test was run on its own and under full-suite load. |
| Sleeper-cell-main `testDebugUnitTest --offline` (branch v2, with that worktree's own uncommitted changes) | ✅ 1,088 tests, 0 failures |
| Built server (`dist/`) resolves `job-mcp.mjs`, `probe-mcp.mjs` and the prompt templates | ✅ checked by import |
| Desktop app | The Electron shell runs the server from this repo with the shell's `node`, so `process.execPath` in the MCP config is `node`, not Electron. Not separately packaged or launched for this check. |

## Automated coverage map (§22.1)

| # | Area | Where |
| --- | --- | --- |
| 1 | OAuth state/PKCE, consent, refresh, invalid grant, per-account secrets | `googleDrive/__tests__/googleDrive.test.ts` |
| 2 | Sanitized settings, status and errors | `googleDrive.test.ts`, `cli.test.ts`, `publication.test.ts` (no paths or secrets in bundles) |
| 3 | Folder idempotency, account switching, uncertain uploads, cross-model reuse | `googleDrive.test.ts`, `jobs.integration.test.ts` |
| 4 | Lossless slicing (2000 px) | `pipeline.test.ts` |
| 5 | Source identity; every slice delivered before analysis | bridge in `jobs.ts`, exercised by `jobs.integration.test.ts` |
| 6 | Prompt snapshots, analysis→review order, same conversation | `review/__tests__/review.test.ts` (Kotlin goldens), `jobs.integration.test.ts` |
| 7 | Capability expiry, cancelled submissions, malformed payloads | `jobs.integration.test.ts` (late call refused), review port rejection goldens |
| 8 | Geometry, exclusive bounds, seams, invalid boxes | `pipeline.test.ts`, `review.test.ts` |
| 9 | Double Start, overlapping runs, pause/stop, retry without AI | `jobs.integration.test.ts` |
| 10 | Local import vs R2 state, publish retry, immutable/conditional writes | `publication.test.ts`, `jobs.integration.test.ts` |
| 11 | Human, managed and phone work protection; explicit redo | `pipeline.test.ts`, `publication.test.ts` |
| 12 | Phone format, hashes, source and revision checks, idempotent fetch | `publication.test.ts`, phone `StudioAntigravitySharedPageTest` |
| 13 | Part scoping, status display, disabled modules, blockers | `tests/client/antigravityScreens.test.tsx` |

**Not covered automatically:**
- socket reconnection in the AntiGravity screens (the screens reload from the server on every event);
- a real model's malformed JSON.

## Live walkthrough (§22.3)

| Step | Status |
| --- | --- |
| 1–3 OAuth client, connect, account, root, test transfer | **Verified live**: SHA-256 `56b1de3e…` matched up and down. |
| 4 Series → Part → Image Clipper | **Verified live** |
| 5–6 Prepare pages; Drive hierarchy and slice inventory | **Verified live**: 9 pages, 6 slices each, verified against Drive's own checksums. |
| 7–8 Model chosen; concurrency 1; MCP delivery; same-conversation review | **Verified live**: Claude Sonnet 5.5 Medium, pages 001–004. |
| 9 Pointers checked against the original image | **Verified live** for `page_004` (overlay review). |
| 10 Local import and R2 checksums; review and crop markers unapproved | **Verified live** (R2 read-back) + tested (markers) |
| 11 Phone collects | **Verified live** (operator: page shown as done on the phone) |
| 12 Two pages at once | **Verified live** (run `e0864358`) |
| 13 Stop an in-flight run | **Verified live** (operator, 2026-11-07) |
| 14 Source replacement → stale | **Pending (manual)**: tested only |
| 15 Interrupt between review and R2, then recover | **Verified live** (operator, 2026-11-07) |
| 16 Restart Studio and check summaries | **Verified live** (operator, 2026-11-07) |
| 17 Human review and cutting, then Metadata readiness | **Verified live** (operator, 2026-11-07) |
| 18 Reject a result, run it again, phone takes the replacement | **Pending (manual)**: tested only (added after the operator asked for page-level Reject) |

## Phase 1 live evidence (2026-11-07, operator-authorized)

1. The first sign-in was refused with `403 access_denied` because the account wasn't a test user. Studio stayed disconnected and saved nothing.
2. After the account was added as a test user, sign-in connected `abhishekkandulna14@gmail.com` and created `Manhwa Studio`.
3. The connection test transferred a 4,729-byte PNG in 5.6 s. The local, downloaded and Drive-reported SHA-256 values all matched (`56b1de3e0fb0…f7fa38a5`), and the file was deleted afterwards.
4. A fresh process with no cached token reconnected through the Keychain and reused the same root.
5. Covered by tests only:
   - revoked authorization;
   - the 7-day Testing expiry;
   - a forged callback.
