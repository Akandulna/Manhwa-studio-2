# Script Structure v2 — PRD (draft for review, 2026-11-17)

A new way of writing narration scripts, English and Hinglish, based on how four successful English recap channels
and two Hindi recap channels build their videos. **v2 is added beside today's process; v1 stays exactly as it
is.** A series switches to v2 at the start of a new Part.

**Status (2026-11-17):** analysis done, all decisions taken (§3), no open questions, nothing built.

---

## 1. Goal

Scripts that hold a listener for a full Part, not just accurate panel descriptions. In practice:

- every video Part opens with a hook, a premise and a question;
- each scene explains **why** something happens and **what it changes**, not what the panel looks like;
- fights read as problems being solved, upgrades get a visible payoff;
- chapters flow into each other without re-introductions, with one spelling per name;
- English has a dry, rare narrator voice; Hinglish has a friendly storyteller voice, written natively rather than
  translated.

**Not in scope:** voice/TTS speed (unchanged), word caps (560 aim / 640 stretch stay), source-order and accuracy
rules (unchanged), cropping, Editor 2.0 timelines for chapters (unchanged), calls to action.

---

## 2. Why (the findings, short)

References (in `~/Downloads`):

| Script | Language | Size |
|---|---|---|
| When You Give A Dumbass An Overpowered Ability… (Sandmancer) | EN | 18.8k words |
| When the #1 ASSASSIN Is Reborn at 14yo… | EN | 44.5k words, 3 h 27 m |
| The Youngest Reincarnated Prince… (actually the Leon / holy king story) | EN | 97.5k words, 7 h 05 m |
| He Was BETRAYED But Reincarnated With a PERFECT BODY… | EN | 59.8k words |
| Gamer got Transported into the Game as Barbarian (NoteGPT transcript) | HI (Devanagari) | 15.1k words, 67 m |
| He got Stuck With her Ex-Boss in an apocalypse (Dreamland) | Hindi channel, English text | 5.3k words, 29 m |

What all of them do that our scripts don't:

1. **Opening hook within 2 minutes:** a flash-forward or "imagine…" hook, then premise, the power promise and the
   central question, before the first real scene. Our scripts start on panel description.
2. **Scene shape:** situation → the hero reads it (and why) → action → result → consequence. In the Betrayed
   script, visual description is about 4% of sentences.
3. **Fights as problem solving:** an enemy rule or weakness, a failed approach, a new tactic, a cost. Routine
   fighting gets one line.
4. **Upgrades get a practical payoff** within the next fight or two.
5. **A limit keeps easy wins tense:** hide strength, no magic, a time limit.
6. **Time skips, travel and training compressed to one sentence;** reveals, reversals, deaths and reunions get room.
7. **Continuity:** returning characters re-introduced by role plus one fact; setups planted and paid off; no
   restart at chapter boundaries.
8. **Narrator voice:**
   - **English:** dry, one-sentence irony at scene ends, almost no nicknames.
   - **Hindi:** warm friend voice (हमारा/हमारी, "दोस्तों", "मुझे लगता है"), everyday comparisons (walkie-talkie,
     bulldozer, a piece of bread), heading off viewer doubts ("अब तुम सोच रहे होगे… लेकिन…"), running gags.
9. **Listening aids:** the hero's reasoning stated aloud (पहली बात… दूसरी…), plans stated before they run,
   day/clock counters, cuts to bystanders realising what the hero did.

What they do badly, and v2 must avoid:
- **Filler phrases:** "completely" ×168 in one script, "couldn't believe" ×38 in another, "The problem is" /
  "even worse" in nearly every late scene.
- **Overused stand-in names:** "प्रोटेगर" ×184 in 15k words.
- **Seams between chapters:** backstory told twice back to back.
- **Name spelling drift.**
- **Jokes at deaths, leering or sexual jokes.**
- **A cold open that misrepresents its scene.**

Length is not the difference. For Sandmancer chapters 1–20 the other channel used about 520 words per chapter;
ours average 440, with a cap of 560. The difference is **where** the words go.

---

## 3. Decisions (taken 2026-11-17)

| # | Question | Decision |
|---|---|---|
| EN-1 | Where the opening hook lives | **A separate Part opening at the beginning:** its own script, audio and exported clip |
| EN-2 | English narrator voice | **Dry and rare** |
| EN-3 | Word aim/cap per chapter | **Keep it:** 560 aim, 640 stretch, under 4 minutes |
| HI-1 | Hinglish narrator voice | **Friendly**, with caps (§6) |
| HI-2 | Call to action at Part end | **No call to action** |
| HI-3 | Ship Studio and phone together | **Yes:** every rule change lands in Studio and phone in the same release, fingerprint-pinned |
| V | Versioning | **Build as v2; v1 stays exactly as today** |
| EN-4 | Call to action in English | **None.** v2 writes no CTA or outro lines in either language |
| P-1 | Hook teasing a later moment of the same video | **Yes**, including Part 1 of a brand-new series |
| P-2 | When the opening is made / where it shows | **Made last** (once every chapter of the Part is ready to take input from), **shown first** (top of the Part in every UI) |
| P-3 | Opening voice | **Same voice as the chapters** |

---

## 4. Versioning: v1 frozen, v2 beside it

### 4.1 Per-series switch
- New series field **`scriptV2FromChapter`** (chapter number, nullable). Empty means the series is v1 everywhere.
  Chapters at or above that number are written with v2.
- Settable only at a **Part boundary:** the first chapter after a chapter marked Part end, or chapter 1 for a new
  series. Narration's series page gets a **"Script structure: v1 / v2 from Part N"** control. It refuses to switch
  in the middle of a Part.
- Each saved `ChapterScript` records **`structure`** (`v1` | `v2`), so the app always knows which rules wrote it.
  The Hinglish of a v2 English script is always written with v2 Hinglish rules.

### 4.2 Rule texts
- The v1 constants stay byte-identical: `SCRIPT_STYLE`, `QUALITY_RULES`, `PACING_RULES`, `lengthCutRule`, the
  manual `ORDER_RULES`, `HINGLISH_*`. The existing fingerprint (`HINGLISH_RULES_SHA256`) must not change; that is
  the test that proves v1 is untouched.
- v2 rules live in their own files (`narrationRulesV2.ts`, `hinglishRulesV2.ts` and phone counterparts) with their
  own fingerprint (`V2_RULES_SHA256`, covering English and Hinglish v2 texts) pinned on both sides.
- Every writer (§11) picks the rule set from the chapter's structure, never from a global switch.

### 4.3 Phone
- The phone learns a series' v2 start chapter from the series entry in its `index.json` (both writers already
  merge it, see `phoneIndexMerge.ts`). No relay change is needed.
- A phone APK without v2 support must **refuse** to write a v2 chapter and say so, rather than silently write v1.
  The rollout order is APK first, then switch a series.

---

## 5. v2 English rules

### 5.1 Style (replaces `SCRIPT_STYLE` for v2)
- Third person, present tense for action, past tense for backstory. Short sentences for voice-over.
- **Scene shape:** situation → the hero reads it (why) → action → result → consequence.
- **Speech:** mostly reported speech, plus **1–3 direct quotes per chapter** for the lines that matter.
- **Narrator voice: dry and rare.**
  - At most **one** narrator line per ~200 words, only at the **end of a scene**.
  - Forms: irony, an understatement, a one-line comparison.
  - **None** in a scene whose plan mood is *grief* or *tense*.
  - No "our boy", "our MC", slang or memes.
- **Narrator lines comment; they never state a story fact that isn't on the pages.**
- No stage directions and no excessive punctuation (unchanged from v1).

### 5.2 Storytelling (replaces `PACING_RULES` for v2)
- **Keep visual description only when it** establishes a clue, explains an action or sets a necessary sense of
  scale. Spend the rest on motive, meaning and consequence.
- **Fights:** state the enemy's rule or weakness, why an approach fails, the new tactic and its cost. Routine
  exchanges get one line.
- **Upgrades:** state what a new power, item or technique practically lets the hero do.
- **The hero's limit**, from the ledger, is mentioned when it shapes a choice.
- **Reasoning aloud:** when the hero deduces or plans, say the steps in order before the action.
- **Compress** time skips, training, travel and permissions to one sentence each. **Expand** reveals, reversals,
  deaths, reunions and relationship turns, following the plan weights (§8).
- Keep from v1: explain each fact once, don't restate an emotion the action already shows, no filler transitions.

### 5.3 Chapter start and end (replaces the v1 "never bridge" lines for v2)
- The chapter still starts with its own first story event and keeps source order.
- A **one-clause bridge** built from the ledger's LAST MOMENT is allowed ("Back on the bus, Zeon…"). It may not
  replay an event.
- **Never re-introduce** a person, place or problem the ledger already knows. Refer to people by name, or by role
  plus one fact if they haven't appeared for a while.
- A chapter may end on a **story hook the pages show** ("Just then, a warning bell rings"). Announcing it ("the
  chapter ends on a cliffhanger") stays banned.

### 5.4 Length (v2 length cut)
- Same numbers as v1: about 30% under the draft, 560 aim, 640 stretch, never beyond.
- **What gets cut first, in order:**
  1. visual description
  2. restated reactions
  3. travel and routine action
  4. filler transitions
  5. secondary dialogue
- **Protected:** the "why" and "what it means" lines, the plan's *expand* scenes and narrator lines (which still
  count toward the cap).

### 5.5 Banned crutches (English, checked in §10)
"completely" (more than 2 per chapter), "couldn't believe" / "can't believe", "everyone is in (total) shock",
"the problem is" (more than 1), "even worse" (more than 1), "then the story shifts", "on top of that" (more than 1),
"our boy", "our MC", "little did he know" (more than 1).

---

## 6. v2 Hinglish rules (friendly)

Keeps everything in v1's `HINGLISH_LANGUAGE` about spoken Hindi: Devanagari only, 25–40% English, present tense,
spoken forms, the twist at the end of the sentence. The changes are below.

### 6.1 Voice (replaces "calm and measured with a dry wit")
- **A friend telling the story.** हमारा/हमारी for the hero and allies ("हमारा ज़ियॉन", "हमारी एल्फ").
- **Per chapter caps:**
  - viewer address ("दोस्तों", "इमेजिन करो", "अब तुम सोच रहे होगे… लेकिन…"): **≤ 2**
  - personal line ("मुझे लगता है…", "भाई…"): **≤ 1**
  - "दोस्तों" + "भाई" together: **≤ 2**
- **Everyday comparisons:** at least one wherever a fantasy item, power, price or scale needs explaining
  ("ये कुछ-कुछ वॉकी-टॉकी जैसा है", "बुलडोज़र की तरह", "एक ब्रेड के टुकड़े जितनी कीमत").
- **Running gags** tied to a character's habit are allowed. **Callbacks** to earlier moments are encouraged.
- **Heading off viewer doubts** ("अब तुम सोच रहे होगे कि… लेकिन इसकी एक वजह है") is allowed when the source
  gives the reason.
- **No jokes** in grief or tense scenes. **No sexual or leering jokes.** **No channel chatter** ("मैं ये सीरीज
  इसीलिए…").
- **Narrator lines comment; they never add a story fact.**

### 6.2 Word choice
- **English words preferred:** सिचुएशन, प्रॉब्लम, डिसाइड, कंफर्म, इंफॉर्मेशन, प्लान, एक्साइटेड, ऑब्जर्व, रियलाइज़,
  in addition to v1's list.
- **Avoid literary Hindi** in narration: विशाल, ग्रह, चेतावनी, रुतबा, नौजवान → बहुत बड़ा, प्लैनेट, वॉर्निंग,
  स्टेटस, लड़का. The list is in the rules.
- **Banned:** "प्रोटेगर" / "प्रोटैगनिस्ट" as a stand-in for the name. Use the name; "हमारा हीरो" at most twice per
  chapter.
- **Names:** spelled exactly as in the ledger's Devanagari column (§7).

### 6.3 Structure
- Keep the `[SCENE n: Px–Py]` markers and full paragraph coverage, unchanged. Editor 2.0 timelines and voiceover
  alignment depend on them.
- **Inside a scene,** the Hinglish follows the scene's plan (purpose, weight, mood), not the English sentences.
- **Voice slots** marked in the plan are filled with native Hinglish lines. The English narrator line is **not**
  translated.
- **Length:** the same 85–130% window as v1. Voice lines replace translated English asides; they are not added on
  top.
- **Reasoning aloud:** "पहली बात… दूसरी बात…" when the hero deduces.
- **Day and clock counters** are kept when the source has them.

---

## 7. Story ledger (replaces the ~200-word rolling summary in v2)

### 7.1 Content
Fixed sections, about **350 words maximum**, English:

```
GOAL: <the hero's long-term aim>
ARC QUESTION: <what the current arc is about>
LIMIT: <what he must hide / can't use / is racing against, or "none">
CHARACTERS:
- <Name> | <देवनागरी> | <role> | <one defining fact>
POWERS:
- <power/item> | <what it practically does>
OPEN SETUPS:
- <planted thing> (ch N) → <what it may pay off>
STORY SO FAR: <~120 words, the story through this chapter>
LAST MOMENT: <one sentence: where this chapter ends>
```

### 7.2 Rules
- **Rewrite, don't append.** Sections are updated in place. Paid-off setups are removed. Characters who have left
  the story drop to one line or are removed.
- **CHARACTERS is the spelling authority** for both languages. A new name is added the first time it is
  readable on the pages.
- **Storage:** written in the existing `===SUMMARY===` slot and `rollingSummary` field, so phone import, Part archive
  continuity, script replacement, Gemini and AntiGravity carry it unchanged.
- **Hinglish scripts** keep today's short Hinglish summary in their own row. The ledger is English only.

### 7.3 Seeding an existing series
For a series switching to v2 mid-story (e.g. Sandmancer at Part 2), a one-time **"Build ledger"** job reads the
existing English scripts and summaries up to the switch chapter and writes the first ledger. The job runs on an
AntiGravity engine or as a manual prompt. You review it in a dialog before it's saved on the last v1 chapter's row.

---

## 8. Scene plan (new step, v2 only)

### 8.1 What it is
After the notes and before the draft, the writer plans the chapter's scenes. One entry per scene:

| Field | Values |
|---|---|
| `pieces` | image range, e.g. `P0003-T001–P0006-T002` |
| `purpose` | goal · obstacle · turn · consequence · setup · payoff |
| `weight` | compress · normal · expand |
| `mood` | normal · tense · grief · comic |
| `fight` | optional: rule/weakness → failed approach → new tactic → cost |
| `ledger` | optional: plants X / pays off X |
| `voiceSlot` | none · irony · comparison · viewer-doubt · callback |
| `hookCandidate` | true for a scene strong enough to open the Part with (status reversal, reveal, big win) |

### 8.2 Rules
- **Expand:** reveals, reversals, deaths, reunions, relationship turns, the first use of a power.
- **Compress:** travel, routine fights, permissions, repeated reactions.
- **Voice slots:** at most one per ~200 English words, and never in tense or grief scenes.
- **Mood source:** what the pages show, not the narrator's taste.

### 8.3 Saved
As `script.plan.json` beside `script.md`. Hinglish (§9) and the Part opening (§10) read it. It is deleted with the
chapter's scripts (Clear scripts, Part complete) like the other script files.

### 8.4 Review checks added for v2
- An *expand* scene is not narrated in one sentence.
- A *compress* scene is not longer than two sentences.
- No narrator line in a tense or grief scene.
- The scene order matches the plan, and the plan covers every story image.

---

## 9. Hinglish from the plan (v2)

The conversion receives:
- the final English script (numbered paragraphs, as today)
- `script.plan.json`, with scene ranges mapped onto English paragraphs
- the ledger's CHARACTERS (Devanagari spellings)

The steps stay the same as today: scene notes, then write, then final check. The prompts gain:
- the scene mood and voice slots to fill natively;
- the friendly voice rules and caps (§6.1);
- the name list.

New checks (warnings in Phase 1, rejections once reliable):
- "प्रोटेगर" present
- more than 2 "दोस्तों/भाई"
- a viewer address or joke in a grief or tense scene
- a name spelled differently from the ledger

---

## 10. Part opening (EN-1)

### 10.1 What it is
A short, separate narration at the start of every v2 Part, per language. It is recorded, timed and exported as
its own clip, which you place first when cutting the final video. **No call to action, and no outro, in either
language.**

### 10.2 When it is written: made last, shown first (P-2)
The opening is the **last** script of a Part to be written, because it collects its input from every chapter.

- **The English opening unlocks** only when the Part has a chapter marked **Part end** and **every** chapter of the
  Part has its saved v2 English script, ledger and `script.plan.json`. Until then its row shows the state
  "Waiting for chapters (n of N ready)" and the Write action is disabled.
- **The Hinglish opening unlocks** after the English opening is saved and every chapter's v2 Hinglish script is
  saved.
- **If a chapter script changes after the opening was written** (Replace, "Use phone's version", Clear scripts),
  the opening is marked **Stale**, like a Hinglish script whose English changed. It must be rewritten before export.
  Its source chapters' script hashes are stored with the opening for this check.
- **Automation:** when a run or queue finishes the Part's last chapter (English, then Hinglish), the opening job is
  queued automatically for that language. It can also be started by hand from its row.

**Position in the UI is always first.** Wherever a Part's items are listed, the opening row sits at the **top of
the Part, above its first chapter**, even though it is produced after all of them:
- Narration chapter list
- Editor 2.0 and its checklist
- Voiceover
- Storage / Complete Part
- Phone status lists, when phones support openings in Phase 5b

Exports and the "full script" file put it first as well (§10.7).

### 10.3 Inputs
- the Part's ledgers (first and last chapter)
- every chapter's `script.plan.json` (the `hookCandidate` scenes)
- the Part's chapter scripts
- for Part 2 and later: the previous Part's last ledger

### 10.4 English output
`<Series root>/Part NN - opening.md`, 150–300 words (about 1–2 minutes):

1. **Hook:** 3–6 sentences retelling one hook-candidate scene **from this Part only, preferably its second half**,
   in present tense. Teasing a later moment of the same video is intended (P-1), Part 1 of a new series included.
   It must match the actual scene: no stronger lines than the pages give.
2. **Bridge:** one line ("To see how he got here, we go back to where it started").
3. **Premise** (Part 1) or **where we left off** (Part 2+, 2–3 sentences).
4. **Power promise:** what makes this hero's fantasy different.
5. **Central question** the Part answers.

It also records **`hookSource`**: chapter number plus piece/page range, used for visuals.

### 10.5 Hinglish output
`Part NN - opening.hi.md`, 150–330 words, written **natively** from the same inputs plus the English opening as
reference. It is not a paragraph-by-paragraph translation. The "इमेजिन करो कि तुम…" form is allowed for the hook.
The friendly voice caps apply.

### 10.6 Checks
- Hook source is inside this Part.
- Every name in the opening is in the ledger.
- No fact that isn't in the chapter scripts.
- Word range respected.
- No CTA wording: "subscribe", "like", "comment", "सब्सक्राइब", "लाइक", "कमेंट".
- Presentation-wording check (v1 check, reused).

### 10.7 Audio, timeline, export
- **Data:** a new `PartOpening` record per series, Part and language. It holds the text, `hookSource`, status,
  audio file, timeline JSON and an export flag. Chapters' `AudioSection` and `Editor2Timeline` rows are not reused,
  so chapter tools keep working unchanged.
- **Voiceover (first release):** Narration's **"Add voiceover"** manual path, extended to the opening (one audio
  file = the whole opening). It uses the **same voice as the chapters** (P-3). Phone voiceover support is a later
  phase (§13, Phase 5b).
- **Timeline:** the AntiGravity **Timeline** process gets an "opening" job:
  - The hook lines use crops from `hookSource`'s chapter and pages.
  - The premise and question lines use crops from the Part's first chapter.
  - Output is the same timeline JSON shape as a chapter.
- **Export:** Editor 2.0 renders the opening to `_video2/Part NN - opening.mp4` (and `_video2_hi/…`). The chapter-
  number scan (`scanExportedChapterNumbers`) must ignore these files.
- **Full script file:** the Part's "Part NN - full script*.md" starts with the opening, then the chapters.
- **Part completion:** Complete Part needs the openings exported too (EN + HI) and deletes them with the Part.

### 10.8 UI (opening row at the top of each Part)
- **Narration series page:** each v2 Part shows an **"Opening"** row at the top, above the first chapter, per
  language tab.
  - Status: Waiting for chapters (n of N) · Ready to write · Writing · Done · Stale.
  - Actions: Write · View · Add voiceover.
- **Editor 2.0:** the same opening row at the top of the Part, with the opening's timeline and export.
- **Checklist:** the "Opening" item is listed first for v2 Parts and is completed last.

---

## 11. Writers: what changes where

| Writer | Today | v2 change |
|---|---|---|
| **Manual prompts** (`narrationManualPrompts.ts`) | notes batches → draft → review → final check; Hinglish scene notes → write → check | v2 step list: notes → **plan** → draft → review → final check, ledger in place of summary; v2 Hinglish prompts with the plan and names; a manual **Part opening** prompt set |
| **AntiGravity Narration** (`antigravity/narrationFlow.ts`, `narrationHinglish.ts`, `narrationStudio.ts`) | stages notes · draft · review · check | v2 stages notes · **plan** · draft · review · check; plan saved; v2 checks; opening job type; Timeline process gets an opening job |
| **Gemini Mac app** (`geminiMcp/english.ts`, `hinglish.ts`, `prompts.ts`) | same stages via MCP | add `plan` stage and v2 rules as data in `get_job` |
| **Phone** (Sleeper-cell-main: NarrationSequence.kt, NarrationPrompt.kt, NarrationPacing.kt, NarrationQuality.kt, HinglishLanguage.kt, HinglishConvert.kt, NarrationReply.kt, ScriptUpload.kt, BrowserDatabase.kt defaults) | phone runs on ChatGPT / AI Studio | v2 prompt set; **plan merged into the draft reply** (`===PLAN===` before `===SCRIPT===`) to save a round trip; plan included in the uploaded script zip; refuses v2 work on an old APK |
| **Phone script import** (`phoneScriptImport.ts`) | script.md + summary/closing | also writes `script.plan.json` and the chapter's `structure` |

All rule text for v2 is shared from one place on each side and pinned by `V2_RULES_SHA256`.

---

## 12. Style check (new, warnings first)

A v2 check runs beside `presentationIssues` on Studio and the phone (`NarrationQuality`). It reports:

**English:**
- §5.5 crutch counts
- narrator lines per 200 words
- direct-quote count (0 or more than 3)
- names not in the ledger
- plan checks (§8.4)

**Hinglish:**
- §9 checks
- the literary-Hindi word list

Results are saved in `script.review.json` and shown in Narration. **Phase 1–3: warnings only** (the script still
saves). They become rejections per rule once a pilot shows they aren't false alarms.

---

## 13. Phases

Every phase ships Studio and phone together (HI-3). Every phase ends with v1 fingerprints unchanged.

| Phase | Builds | Done when |
|---|---|---|
| **0. Switch** | `scriptV2FromChapter` and `ChapterScript.structure`; Part-boundary control; phone reads the switch from `index.json`; old APK refuses v2 | A test series switches at a Part boundary; v1 series are byte-identical in their prompts |
| **1. Rules** | v2 English and Hinglish rule texts (§5, §6); v2 fingerprint; style check as warnings (§12) | Manual, AntiGravity, Gemini and phone all write a v2 chapter using v2 rules; warnings show in Narration |
| **2. Ledger** | Ledger format in the summary slot (§7); name check; "Build ledger" seed job | Sandmancer seeded at its next Part; two chained v2 chapters show no re-introductions and consistent names |
| **3. Scene plan** | Plan step in all four writers (§8, §11); `script.plan.json` saved, imported and deleted correctly; plan checks | A v2 chapter has a saved plan; the review flags an *expand* scene cut to one line |
| **4. Hinglish v2** | Hinglish from the plan (§9), friendly voice, name list, new checks | Hinglish of a v2 chapter fills voice slots natively, keeps scene coverage and stays within 85–130% |
| **5a. Part opening** | `PartOpening` data, EN and HI opening writers (manual + AntiGravity), unlock and Stale rules, auto-queue after the last chapter, checks, manual voiceover, Timeline opening job, Editor 2.0 export, scan exclusion, opening row at the top of each Part, Complete Part includes openings | The opening stays locked until the last chapter is saved, then writes, shows at the top of the Part, goes Stale when a chapter script changes, and exports `Part NN - opening.mp4` in both languages; Complete Part removes them |
| **5b. Phone opening support** | Phone voiceover runs and phone sync know Part openings | An opening's voiceover is made by a phone run |
| **6. Pilot** | v1 and v2 of the same chapters side by side; metrics in `script.review.json` | You've listened to both and the warnings that held up become rejections |

**Recommended first slice:** Phases 0 + 1 + 2 together. Most of the gain is in the voice and continuity rules.

---

## 14. Pilot and measurement

- **Comparison set:** Sandmancer chapters 1–5, rewritten in v2 (EN + HI) beside the existing v1 scripts. Same
  pages, same engine.
- **What to check:**
  - the opening holds attention
  - every decision and fight turn is followable by ear
  - no new facts were added
  - names are consistent
  - word counts stay under the cap
  - Hinglish sounds like a friend talking, not a translation
- **After publishing:** compare YouTube retention (average view duration, first-2-minute drop-off) for the first
  v2 Part against recent v1 Parts.

---

## 15. Risks

| Risk | Guard |
|---|---|
| Narrator lines add facts | "Comment, never new facts" rule; review checks every narrator line against the notes |
| Length creep | Narrator lines count toward the unchanged cap; weight-aware cutting |
| The hook spoils later Parts or misrepresents its scene | Hook source must be inside the Part; the check compares it with that chapter's script |
| Studio and phone drift | `V2_RULES_SHA256` pinned on both sides; old APK refuses v2 |
| AI Studio reply size on phone | Plan merged into the draft reply; the plan is compact (one line per scene) |
| Style checks reject good scripts | Warnings only until the pilot proves each rule |
| A series switches mid-Part | The switch control only accepts Part boundaries |
| Engines ignore caps on friendly-voice lines | Counted by the Hinglish check (§9) |

---

## 16. Open questions

None. Resolved 2026-11-17:
- no English CTA (EN-4)
- the hook may tease a later moment of the same video (P-1)
- the opening is made last and shown first (P-2)
- the opening uses the same voice as the chapters (P-3)

---

## Appendix A — Example (Sandmancer chapter 1 opening)

**v1 (today):**
> Someone has lived like a dog in a harsh world, where the weak lose their wealth, their status, and their lives.
> A terrified young man reaches out amid flying sand as a vast, tooth-lined maw surrounds him.

**v2 Part opening, English (illustrative):**
> A hundred years ago, Earth became a desert. Now Zeon has awakened the power to control sand, which should make
> this ruined world his greatest weapon. There's just one problem: he can barely survive the people sitting next
> to him on a prison bus.

**v2 Part opening, Hinglish (illustrative):**
> इमेजिन करो कि पूरी धरती एक रेगिस्तान बन चुकी है, और तुम्हें मिलती है रेत को कंट्रोल करने की पावर। मतलब पूरी
> दुनिया तुम्हारा हथियार है। लेकिन हमारे ज़ियॉन की प्रॉब्लम ये है कि अभी वो एक बस के गुंडों से भी नहीं बच पा रहा।

**v2 chapter scene (English, a fight beat):**
> His rank has gone up, but his sand missiles still can't pierce the queen's shell. More power hasn't solved the
> problem. So Zeon changes the plan: if he can't break the armour, he'll tear it off.

## Appendix B — Reference analyses
The full analyses behind §2 were given in chat on 2026-11-17 (English: four channels; Hindi: two channels). The
reference transcripts are in `~/Downloads` under the titles listed in §2.
