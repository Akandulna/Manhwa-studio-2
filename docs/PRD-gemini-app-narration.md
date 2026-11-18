# Gemini app Narration — plan (draft for review, 2026-11-12)

Write a chapter's **English and Hinglish narration scripts in the Gemini Mac app**, using the app's own Gemini
quota. The Studio prepares the pages, checks every step and saves the scripts; Gemini reads and writes.

**Status (2026-11-12):** Phase 0 done (0a ✅, 0c ✅, 0b skipped). **Phase 1 done** (Gemini called `get_job` through
the new connector). **Phase 2 built:** `GeminiAppJob` table (DB backed up first), `services/geminiMcp/jobs.ts`
(Process / Master queue / Stop / Cancel, preparation worker: pieces with fresh codes → Drive
`Manhwa Studio/gemini-narration/<Series> · Ch <N> · <code>/C012-P0003-T002.jpg`, 3 chapters uploaded ahead for
Master, cut-off uploads restart after a server restart), `prompts.ts` (Process + Master prompts), routes under
`/api/gemini-mcp`, pages `/gemini-mcp` → series → workflow graph → Narration Studio (English / Hinglish tabs).
Phase 2 gate passed (Rebel of the Apocalypse Academy ch 1: 115 pieces in Drive, Gemini saw the folder).
**Phase 3 built:** `services/geminiMcp/english.ts` (stage data + checks: notes in batches of 10 → draft → review →
check, using narrationFlow's readNotes / checkDraft / readReview / readCheck; rules as data in `get_job`, material via
`get_reference` notes/draft/review/context; Gemini's field names mapped; 4 rejections in a row at a stage/batch →
Needs attention), save through `saveEnglishScript` (provider "Gemini app"), Drive folder deleted after save. Phase 3 pilot passed
(C001-EN-T96F saved, ≤45 min for 115 pieces; jobs now record start, step times and rejections). **Phase 4 built:**
`services/geminiMcp/hinglish.ts`: hi_scenes (scene ranges cover every English paragraph once) → hi_script → hi_check,
both checked with `parseManualNarration` (Devanagari, scene ranges, 85–130% length window), saved through
`replaceChapterScript(hi, manualOutput, sourceSha256)`; rules shared with the manual prompts via `hinglishRules.ts`;
a changed English script stops the job. Phase 4 pilot passed (C001-HI-HE4D: 1 min 54 s, 1 rejection,
1,206 words = 107% of English). **Phase 5 built:** Retry (keeps accepted work; failed uploads re-upload), job Log
(accepted steps + every rejection with its problems), a stopped Master chapter pauses the queue (`get_job` → `none`
with `paused_at`), extra final-check refusal of "his name is revealed" commentary (Gemini only; shared phone-synced
checks untouched), Drive cleanup button, Master prompt handles `waiting`. Test leftovers removed (Drive
`gemini-probe`, `~/.local/share/manhwa-probe`, `Temp/gemini-app-probe`). Remaining: a Master chain run over several
chapters; the user's own Drive folder `manhwa-probe` (outside Studio's drive.file access) is deleted by hand. The test results this plan rests on are in [§9](#9-what-the-tests-proved-group-1-2026-11-12).

---

## 1. How it works (the short version)

1. **Prepare** (Studio): you tick chapters and click **Prepare for Gemini**. The Studio cuts each chapter into the
   usual ≤2,000 px pieces with `P0003-T002 · CHECK K7QM` bands and uploads them to Google Drive, one folder per
   chapter.
2. **Start** (you): in the Gemini app, a new chat, paste the trigger line, e.g.
   `@Manhwa Narration next chapter`.
3. **Work** (Gemini ↔ Studio): Gemini asks the connector for the job, reads the pieces from Drive, and submits each
   stage. The Studio checks every submission with the same checks AntiGravity Narration uses today and answers
   `accepted` (with what comes next) or `rejected` (with the exact problems).
4. **Save** (Studio): the accepted English script is saved through Narration's normal Replace path (backup, reset,
   send to phones). The Hinglish is a separate job in its own chat, saved the same way.
5. **Stops halfway?** Open a new chat and paste the prompt again (or let a Gemini schedule do it). The Studio
   remembers every accepted stage, so nothing is redone. The **Master** prompt chains chapters by itself (§5).

---

## 2. The parts

| Part | Where | What it does |
|---|---|---|
| **Connector** (relay) | `~/.local/share/manhwa-studio/gemini-mcp/connector.mjs` (source `server/resources/gemini-mcp/connector.mjs`) | Tiny stdio MCP server the Gemini app starts. Only relays tool calls to the Studio, like `job-mcp.mjs` does for agy. Must live in `~/.local` (the app's sandbox can't read Documents). |
| **Bridge** | Studio API `/api/gemini-mcp/bridge/call` | Loopback-only, needs a token the connector reads from a 0600 file. All logic and checks live here. |
| **Job store** | new table `GeminiAppJob` | One row per chapter + language: stage, Drive folder, pieces with their check codes, accepted notes/draft/review, issues, timestamps. |
| **Drive folders** | `My Drive / Manhwa Studio / gemini-narration / <Series> · Ch <N> · <code>` | One folder per prepared English chapter (Hinglish needs none). The 4-letter `<code>` keeps folder names unique. File names also carry the chapter: `C012-P0003-T002.jpg`. |
| **Procedure** | a Gemini **skill** (or the trigger prompt; see Phase 0) | The step-by-step loop Gemini follows. It must come from *you*, not from the tool (see rule 2 in §3). |
| **UI** | Sidebar **PROCESSOR → Gemini MCP** (new item next to AI Engines), route `/gemini-mcp` | Series list → series workflow graph → **Narration Studio** (only enabled node) → chapter list with per-chapter **Process** and a **Master** button. See §5. |

Reused as is: `prepareChapterPages` (pieces + codes), `narrationStudioDeps` (chapter input + save),
`readNotes` / `checkDraft` / `readReview` / `readCheck` / `qualityIssues` / `unsupportedNames` (English checks),
the Hinglish steps from `narrationManualPrompts.ts` and the Hinglish validation in `replaceChapterScript`.
`jobs.ts` (the agy scheduler) is **not** touched: the Gemini app isn't something the Studio starts or stops.

---

## 3. Rules learned from the tests

1. **Images only through Google Drive.** The app drops images returned by a tool.
2. **Tool replies are data, never orders.** A reply saying "open the Drive folder… then call submit…" made Gemini
   refuse ("permission policy"). Replies are JSON: `status`, `stage`, folder, files, issues.
3. **The tool list never changes.** The app saves it when the connector is added; changing tools means removing and
   re-adding the connector. So: 3 generic tools (below), stages are data.
4. **Tools carry hints** (`readOnlyHint`, `destructiveHint: false`), or the app asks "Allow?" on every call.
5. **Accept Gemini's own field names.** It ignores the input schema (`check`/`text` instead of
   `checkCode`/`bubbleText`, plus extra fields). The Studio maps known aliases instead of rejecting.
6. **Trust only the Studio's checks.** Gemini's chat summary left out its failed attempts.

### The three tools (fixed for good)

| Tool | Hint | Purpose |
|---|---|---|
| `get_job` `{ job? }` | read-only | Current stage of the given job, or the next ready job. Returns the stage, Drive folder + file names for this batch, chapter context (series, previous summary/closing, overview). |
| `get_reference` `{ job, name }` | read-only | Longer data a stage needs, on request: `rules` (style/order/quality rules), `notes`, `draft`, `review`, `english_script`. Keeps `get_job` small and lets a fresh chat catch up. |
| `submit` `{ job, stage, content }` | not destructive | One tool for every stage: `notes`, `draft`, `review`, `check`, `hi_scenes`, `hi_script`, `hi_check`. `content` may be text or JSON. Reply: `accepted` + next stage, or `rejected` + problems. |

---

## 4. The stages (one chat per chapter)

| # | Stage | Gemini does | Studio checks (existing code) |
|---|---|---|---|
| 1 | `notes` × batches of 10 (the app's per-prompt file limit) | Reads the batch's pieces from Drive; per piece: check code, events, printed text, opening/closing | `readNotes`: ids, order, **check codes**, story vs non-story, no unresolved evidence |
| 2 | `draft` | Writes the narration + summary + closing (+ about for chapter 1) | `checkDraft` |
| 3 | `review` | Maps every paragraph to its pieces, corrects against the notes (may reopen pieces in Drive) | `readReview`: coverage, no backward jumps, **names must be printed or known** |
| 4 | `check` | Final spoken-narration check | `readCheck` + `qualityIssues` |
| — | **save English** | — | `replaceChapterScript(en, generated)`, refuses if the script changed meanwhile |
| 5 | `hi_scenes` | Scene notes from the saved English script | Hinglish step 1 checks |
| 6 | `hi_script` | Hinglish in Devanagari with `[SCENE n: Px-Py]` marks | scene coverage, Devanagari, length window |
| 7 | `hi_check` | Final Hinglish check | then **save Hindi** via `replaceChapterScript(hi, manualOutput, sourceSha256)` |

- A rejected submission returns the exact problems; Gemini fixes and resubmits in the same turn (test 1 passed).
  After 4 rejections at one stage the job stops as **Needs attention** (same limit as AntiGravity Narration).
- English (stages 1–4) and Hinglish (stages 5–7) are **separate jobs in separate chats**. A Hinglish job needs the
  chapter's English script saved first.
- Rewriting a chapter that already has a script is opt-in (tick "Rewrite") — same as the agy flow.

---

## 5. What you see in the Studio (decided 2026-11-12)

Scripts only for now.

1. **Sidebar → PROCESSOR → Gemini MCP** (new, beside AI Engines) → **list of series**.
2. **Click a series** → its **workflow graph**: Narration Studio, Image Clipper, Voiceover, Metadata, Timeline, …
   Every node is disabled except **Narration Studio**.
3. **Narration Studio** → the series' **chapters**, each with English and Hinglish status and:
   - **Process** — prepares that chapter (pieces → Drive) if needed and shows the **prompt to paste** into a new
     Gemini chat. Starts or **redoes only that chapter**. English and Hinglish are **separate jobs and separate
     chats** (Hinglish needs the English script saved first).
   - Live stage: `Uploading` → `Ready` → `Reading 3/12` → `Draft` → `Review` → `Check` → `Saved`
     (or `Needs attention` with the last problems), plus **last activity** time so a stalled chat is obvious.
4. **Master** button — queues the chapters to do **in order, one by one**, and shows the **starting prompt**. That
   prompt makes Gemini: ask the Studio for the next job, do it, and at the end **create a one-time Gemini schedule
   1 minute later** with the same prompt. The scheduled run takes the next job, and so on; when the Studio says
   nothing is left, Gemini schedules nothing and the chain ends. (Needs Phase 0c.)
5. After a chapter's script is saved, its **Drive pieces are deleted**.
6. **Settings → Gemini MCP**: install/repair the connector (relay + token into `~/.local`), show the exact command
   for Gemini's *Add custom connected app* form, and **Test connection** (when the app last called it).

---

## 6. Phases

| Phase | What | Gate before moving on |
|---|---|---|
| **0 — three more probes** (no Studio changes) | **0a.** Does Gemini follow long writing rules delivered as *data* (`get_reference("rules")`)? **0b.** Can a Gemini **skill** (loaded from a folder the Studio writes) hold the procedure, and does it pick up edits without you? Low priority: you'd rather not rely on skills. **0c.** Master chain: can Gemini create a one-time schedule from inside a chat, and does the scheduled run use the connector + Drive with nobody watching? | 0a decides how rules reach Gemini (if it fails: trigger prompt or skill). 0c decides whether Master can chain by itself (if it fails: Master gives one prompt per chapter). |
| **1 — connector + bridge** | Relay script, token, bridge route, Settings install + test | Gemini calls `get_job` and gets a real (empty) answer |
| **2 — prepare** | `GeminiAppJob` table (DB backup first), pieces → Drive with unique names, UI section, copy trigger | A chapter shows `Ready`; files visible in Drive |
| **3 — English** | Stages 1–4 + save | **Pilot:** one full real chapter → script saved, compared with its agy/Codex script |
| **4 — Hinglish** | Stages 5–7 + save | Pilot chapter's Hinglish saved and passes the existing checks |
| **5 — polish** | Resume in a new chat, Needs attention / Retry / Start over, Drive cleanup, usage notes | Group 2 tests below |

**Group 2 tests (during phases 3–5):** whole chapter in one chat (40–100 pieces), wrong-file rate, minutes per
chapter, script quality vs agy, Hinglish quality, how much Gemini usage one chapter takes, stop + resume.

---

## 7. Risks

| Risk | What we do |
|---|---|
| The app blocks long rule text coming from a tool (like it blocked orders) | Phase 0 decides; fallback is a skill or the trigger prompt |
| A whole chapter is too long for one chat / hits a usage limit | Stages are saved one by one; continue in a new chat |
| Gemini opens a file from the wrong chapter | Unique folder + file names; check codes reject it anyway |
| Gemini changes the app, connector form or Drive access | The bridge is ours; only the relay and procedure would change |
| A phone writes the same chapter meanwhile | Save refuses when the script changed (existing `expectedSha256` check); Prepare skips chapters with scripts unless Rewrite is ticked |
| Drive fills up with pieces | Delete the chapter's Drive folder once its scripts are saved |

---

## 8. Decisions (made 2026-11-12)

1. **English and Hinglish: separate jobs, separate chats.**
2. **Drive: delete** a chapter's pieces once its script is saved.
3. **Where: PROCESSOR → Gemini MCP**, series → graph → Narration Studio → chapters (§5). Scripts only for now.
4. **Trigger:** per chapter, **Process** gives a prompt for that chapter only (start or redo). **Master** gives one
   starting prompt that runs the queue one by one, chaining itself with a 1-minute Gemini schedule (§5.4).
5. Skills: not relied on (they would need manual updates); tested in 0b only in case the Studio can update them.

---

## 9. What the tests proved (Group 1, 2026-11-12)

Probe server `~/.local/share/manhwa-probe/probe-mcp.mjs`, pieces from *I Became a Cheat-Level Skill Thief* ch2/ch3
page 1, uploaded by the Studio to `Manhwa Studio/gemini-probe/`.

| # | Test | Result |
|---|---|---|
| 1 | Fix loop: a correct batch rejected on purpose | ✅ re-checked and resent the same correct code |
| 2 | Long turn | ✅ 9 pieces, 6 tool calls in one reply, ~17 s per piece |
| 3 | Same file names in two folders | ✅ 17/17 codes from the right folder |
| 4 | Files uploaded by the Studio's Drive connection | ✅ |
| 5 | Long text through a tool | ✅ 1,911 English words and 1,711 Hindi (Devanagari) words arrived whole |
| 6 | Resume in a new chat | ✅ continued at batch 2 |
| — | Per-call approval box | ✅ gone after adding tool hints and re-adding the connector |

Earlier: images returned by a tool are dropped by the app; images in Drive are read correctly (all codes right,
bubble text matches the pages).
