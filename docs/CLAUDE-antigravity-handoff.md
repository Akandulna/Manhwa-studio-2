# Claude implementation handoff: Studio AntiGravity

Read [PRD-antigravity-studio.md](PRD-antigravity-studio.md) completely before editing.

Implement it in the current Manhwa Studio repository. Preserve the substantial existing modified and untracked work; do not reset, clean, broadly reformat, or replace unrelated changes.

The paired Android checkout is `../MAPI/Sleeper-cell-main`, branch `v2`. Read its `AGENTS.md` before working there. PRD section 9.1 now lists the verified Crop Pointer, Review, shared-rule, default-rule, and four-stage prompt sources. The phone's saved Prompt Library entry can still differ from the bundled Crop Rules default.

## Required execution order

1. **Google Drive first:** implement Studio settings, Desktop OAuth configuration import, system-browser sign-in, secure token storage, account display, missing-folder creation, and a verified upload/download test.
2. Prove the official local Antigravity CLI can use a selected model, receive an actual image through the Studio MCP server, and resume the exact conversation for a second turn.
3. Build AntiGravity → Series → Part → Workflow → Image Clipper → Chapters/pages.
4. Wire lossless slicing, Drive upload, analysis, separate same-conversation review, strict JSON validation, and normal Clipper candidate import.
5. Publish versioned results/indexes to R2 and verify both Studio and a compatible Sleeper-Cell consumer.
6. Add bounded parallelism, durable recovery, pause/stop/retry, and stale/conflicting-result protection.
7. Complete relevant regressions/builds, operator guides, and real acceptance evidence.

## Non-negotiable requirements

- The Antigravity managed agent API is excluded. Use the official local `agy` CLI and its official login.
- Studio slices and uploads directly to Drive. Antigravity retrieves those inputs through MCP.
- Create `Manhwa Studio/<Series Name>/Chapters/<Exact Chapter Folder>/` automatically.
- The Drive account is selected by the operator through Google OAuth; never request passwords.
- Only Image Clipper is active. Narration, Voiceover, Metadata, and Editor display Coming Soon.
- One original page, all its slices, one conversation per attempt. Separate pages may run in parallel.
- Studio sends the separate review turn using the stored conversation ID, never “continue latest.”
- Reuse current production Crop Pointer and Review templates; if absent, provide settings import and identify the missing text.
- Pin and record the selected model and distinguish requested from verified model identity.
- Keep final normalized coordinates relative to the correct original page.
- AI review never creates human approval, production cuts, or fake Metadata.
- Preserve existing pointers and managed/phone/manual ownership; regeneration uses the existing explicit redo contract.
- Uploading arbitrary JSON to R2 is not consumer compatibility. Implement/test the versioned collection adapter or report that gate incomplete.
- Keep OAuth/Antigravity/R2 secrets out of generic settings responses, prompts, browser storage, logs, and R2 envelopes.
- Use additive migrations and scoped tests. Never reset the production database.

## Existing environment evidence

At PRD creation, read-only checks found `agy` version 1.5.2 and relevant CLI flags. Login, model entitlement, MCP image visibility, same-conversation generation, Drive authorization, and phone interoperability were not tested.

Recheck the installed version and primary documentation before relying on a capability. Do not install/update tools or change global Antigravity configuration silently.

## When external input is missing

Finish the current phase's implementation, meaningful mocked tests, and setup guide. Then identify the exact missing operator action, OAuth configuration, prompt pack, or paired Android repository/build.

Never call an unperformed live gate passed. Do not stop solely to ask for phase approval when the user has already authorized implementation and the next step is within scope.

## Completion report

Report completed PRD acceptance IDs, changes, migrations/dependencies, actual tests/builds, real integration evidence, and any remaining external requirement. Keep the distinction between implementation finished, live verification pending, and end-to-end verified.
