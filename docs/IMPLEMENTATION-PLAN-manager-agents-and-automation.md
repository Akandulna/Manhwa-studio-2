# Implementation Plan: Manager Agents and Reliable Automation

**Date:** 18 October 2026  
**Status:** Phase 4 is complete for the managed default-ChatGPT crop-page workflow on two installed phones; see the [current sign-off](../../MAPI/Sleeper-cell-main/docs/managed-phase4-acceptance.md). The subsequent Sandmancer Chapter 002 production pilot completed reviewed cuts, corrected narration, fresh voiceover/alignment, a provider-generated timeline and a verified MP4. Phase 5 audits, confirmed account links, scoped quota evidence, atomic account reservations and policy-based initial selection are implemented and locally validated for the managed crop workflow; deployment and installed-device acceptance are pending. Earlier phase implementation paragraphs below retain their milestone dates and must be read with the latest acceptance record.
**Specification:** [PRD v1.1](PRD-manager-agents-and-automation.md)  
**Scope:** Manhwa Studio, Sleeper-Cell, and the Cloudflare relay

## 1. Delivery approach

Implement the PRD through small releases that first observe existing behavior, then establish durable ownership, and finally enable bounded recovery. Preserve existing services and introduce the managers as explicit responsibilities around them.

The organization remains **12 shared roles + 9 roles per phone**. Do not build a separate service for every role. A module reporter, validation function, and durable status record can implement a role inside the existing application.

The implementation sequence is:

| Phase | Deliverable | Depends on | Production behavior enabled |
|---|---|---|---|
| 0 | Contracts, ownership decisions, migration design, test fixtures | PRD | None |
| 1 | Unified status and Issues Manager | 0 | Observation and reporting |
| 2 | Website UI Monitor and required reporting chain | 1 | UI-change detection and notifications |
| 3 | Durable task authority and one-device execution | 0, 1 | Limited managed execution on one device |
| 4 | Multi-device ownership, reconnect, and safe resume | 3 | Coordinated execution with conservative recovery |
| 5 | Accounts Manager, periodic audits, and execution selection | 1, 4 | Eligible profile selection and capacity waiting |
| 6 | Bounded automatic diagnosis and recovery | 2, 4, 5 | Verified repair and checkpoint resume |
| 7 | Complete module integration and consistent Studio controls | 6 | Full supported production workflow |
| 8 | Failure testing, migration rehearsal, pilot, and rollout | 7 | Validated unattended operation |
| 9, optional | AI-assisted diagnosis | 8 | Advisory explanations only |

Phase 2 and Phase 3 can be developed independently after their prerequisites, but each must pass its own gate. Account data adapters can be prepared after Phase 1; automatic routing waits for shared ownership and reservations.

PRD delivery-phase mapping: PRD Phase 1 corresponds to implementation Phases 0–2; PRD Phase 2 to Phases 3–4; PRD Phase 3 to Phases 5–8; PRD Phase 4 to optional Phase 9.

No calendar estimate is committed here. Phase 0 must establish supported website states, current checkpoint coverage, migration complexity, and device-test availability before estimating delivery dates.

## 2. Architecture decisions to establish in Phase 0

### Authoritative records

Use the existing relay's Durable Object integration as the preferred authority for task ownership, attempts, commands, resource reservations, and incidents. Initially keep the workspace's related coordination records within one transactional authority rather than introducing cross-shard reservation problems.

The Mac's existing production runner remains the initial scheduling/execution entry point. It asks the authority to assign work and records correlated outcomes. Multiple Studio sessions may propose work, but cannot independently grant ownership. The relay authority persists decisions; it does not depend on an in-memory Mac lock.

For the first release, closing the Mac means no new production scheduling. Phones preserve in-flight outcomes and follow ownership rules; uncertainty is reconciled when coordination resumes. Fully cloud-driven scheduling while the Mac is off is a later scope decision, not an implicit deliverable. This preserves the PRD's conditional treatment of phone-only continuation.

The desktop database and phone storage hold local projections, checkpoints, and durable outbound messages. R2 holds artifacts, attempt-specific staging objects, and catch-up data. R2 status snapshots are not the assignment lock.

### Proposed record families

These names describe new responsibilities, not existing tables or finalized schemas.

| Record | Minimum purpose |
|---|---|
| Entity identity and revision | Map local series/chapter identifiers to stable shared identities; identify current material inputs |
| Manager observation | Source, sequence/version, observed/received time, stage state, availability, evidence |
| Task | Stable unit identity, dependency fingerprint, policy, current state and owner |
| Attempt | Ownership generation, device/profile, checkpoints, renewal/progress information, outcome |
| Command | Unique command ID, task/attempt, intent, acceptance/start/stop/result acknowledgments |
| Artifact evidence | Attempt and input revision, location, checksum/validation, staged versus canonical publication |
| Resource reservation | Device/browser/profile use and account-capacity estimates tied to a task attempt |
| Account observation | Account/profile relationships, scoped capability/quota facts, evidence quality, audit schedule |
| Incident | Cause/resource key, impacts, severity, recovery history, next action, notification state |
| UI baseline/change | Website/page variant, baseline version, comparable evidence, confirmation and reporting state |

### Non-negotiable constraints

- The Automation Manager is the sole logical task dispatcher; managers cannot run competing retry loops.
- Expired ownership does not prove that an already-submitted website request failed.
- Returning workers must reconcile before resuming local work lists.
- Final artifact publication must reject obsolete attempts and input revisions.
- Acknowledgment loss must be distinguishable from confirmed failure wherever evidence permits.
- User pause/cancel and content-review gates override automatic recovery.
- Unknown account information remains unknown; a profile change does not reset shared account limits.
- The Website UI Monitor reports through **Device Image Clipper Manager → Issues Manager → user**, including confirmed cosmetic changes.
- AI assistance has no authority over task ownership, verified completion, or ambiguous resubmission.

## 3. Phase 0 — Contracts, fixtures, and implementation decisions

**Outcome:** Developers can implement against agreed state transitions and failure behavior before introducing new runtime control.

Work packages:

1. Inventory every start/stop path on Studio and phones, including manual runs, scheduled runs, stage-specific controls, and legacy commands.
2. Map existing status sources and validators for all production stages. Separate completion, revision, destination availability, and source freshness.
3. Specify shared entity identity mapping. Preserve original library ownership; do not derive identity solely from titles or filenames.
4. Define versioned observation, task, attempt, command, incident, account, and UI-change contracts with shared TypeScript/Kotlin fixtures.
5. Write state-transition rules, including submitted-but-unknown, result-saved-before-acknowledgment, cancellation, superseded inputs, and rejected stale publication.
6. Choose one pilot workflow with a concrete recoverable unit, preferably one crop page using an existing checkpoint. Validate its actual checkpoint boundaries before final selection.
7. Define feature switches, schema compatibility, isolated test storage, migration mapping, and backup/restore rehearsal.
8. Establish evidence redaction, screenshot retention, supported website states, and the initial owner-approved execution/fallback policies.

**Code areas to inspect:** `productionAutomationModel.ts`, `productionRunner.ts`, `productionAutomation.ts`, `seriesProcessModel.ts`, `phoneRelay.ts`, relay protocol, Android `LibraryAutomationService.kt`, `AutomationService.kt`, `AutoRun.kt`, and workflow checkpoint stores.

**Planned deliverables:** protocol decision record, state-transition fixtures, module ownership map, migration design, and an acceptance-case matrix referring to PRD A01–A32. New protocol/test filenames must be marked as proposed until created.

**Exit gate:** each external action has a defined intent/acknowledgment/checkpoint boundary; every existing dispatch path is classified as integrated, blocked during managed execution, or unsupported. Ownership expiry and request uncertainty have distinct handling.

**Phase 0 artifacts:** [Foundation and validation record](manager-agents/README.md), including protocol decisions, source inventory, module ownership, migration design, versioned wire schema, shared TypeScript/Kotlin fixtures, safety transitions, and A01–A32 traceability. Contract checks, TypeScript compilation, Android JVM decoding fixtures, and existing live receipt delivery/replay pass; Phase 1 observational runtime is now implemented separately from future task ownership. See [validation evidence and limitations](manager-agents/validation.md).

**Rollout/rollback:** documentation and fixtures only; no new production behavior.

## 4. Phase 1 — Unified observations and Issues Manager

**Implementation status (19 October 2026):** source implementation complete across Studio, relay and Sleeper-Cell; local suites and relay process-restart replay passed. Defaults remain off; production relay, local Studio and Nord pilot are now enabled and native installed-phone delivery/replay plus user-confirmed app reopen passed. The synthetic phone-output → cloud → Mac trace passes; a new real chapter import remains a broader rollout gate. See [handoff](manager-agents/phase1.md) and [validation evidence](manager-agents/validation.md).

**Outcome:** The owner can see trustworthy progress and blockers before managers start changing execution behavior.

Work packages:

1. Add the shared observation envelope to existing Mac and phone reporters, retaining source timestamps and revision identity.
2. Add local durable outbound queues and relay deduplication for the new records; preserve existing receipt compatibility.
3. Implement source-aware aggregation. Show old phone information as last known rather than newly verified when the dashboard refreshes.
4. Add incident persistence, grouping by cause/resource, recovery history, acknowledgment/resolution distinction, and reconnect delivery.
5. Add manager health/freshness indicators and an initial Issues inbox in Studio. Link incidents to the existing chapter/device/account screens.
6. Wrap the six desktop production module responsibilities and existing phone reporters with observation adapters. Include passive account observations but no new periodic profile navigation yet.
7. Run the new projections alongside existing progress displays and record disagreements without automatically repairing production state.

**Existing integration points:** `seriesProcess.ts`, `seriesProcessModel.ts`, `phoneReceipts.ts`, `seriesActivity.ts`, `phoneRelay.ts`, `server/src/index.ts`, `relay/src/index.ts`, `ProcessTracker.kt`, `ScriptReceipt.kt`, `ClipperReceipt.kt`, `StudioRelay.kt`, `useSeriesProcess.ts`, and `usePhoneReceipt.ts`.

**Proposed additions:** observation/incident services and relay record handlers; a small manager registry and status view. Keep semantic source authority in the existing module validators.

**Verification:** fixtures for duplicate/out-of-order updates, old input revisions, failed outbox delivery, offline replay, grouped incidents, and source freshness. Primary PRD cases: A20 and A22; establish the reporting portions of A10 and A21.

**Exit gate:** one chapter can be traced from phone output to cloud availability to Mac import without collapsing these facts into one completion flag. Incidents survive restarts and do not multiply on replay.

**Rollout/rollback:** enable observation per device/module. Disable the new views/reporters if needed while retaining incident history; existing execution remains unchanged.

## 5. Phase 2 — Website UI Monitor Agent

**Implementation status (19 October 2026):** source implementation and local acceptance checks complete for all three providers, with durable device-manager routing, baseline review/verification, passive hooks, deferred audits and Studio evidence views. The phone switch remains off. Production relay deployment, a new GitHub Actions APK, real-page baseline review, visual QA and device overhead/crash instrumentation remain release gates. See [Phase 2 handoff](manager-agents/phase2.md).

**Outcome:** UI changes in ChatGPT, Gemini, and Google AI Studio reach the user through the exact requested chain.

Work packages:

1. Create one phone-local Website UI Monitor covering all three providers. Reuse existing page-state and diagnostics access rather than creating another browser session.
2. Define baseline manifests for supported workflow/page states, viewport, locale, theme, and account/profile variants. Start with required controls and recognizable layout regions; add targeted visual comparisons where structure alone is insufficient.
3. Filter expected conversation text, streaming responses, timestamps, loading states, and known login/quota overlays.
4. Classify observations as baseline missing, unchanged, suspected change, confirmed informational change, or compatibility blocker. A first observation cannot prove a redesign.
5. Implement durable local handoff to the Device Image Clipper Manager, which attaches clipping impact and forwards to the Issues Manager. Record both handoff acknowledgments and a stable change ID.
6. Add user notifications for every new confirmed change, including cosmetic changes. Merge repeated observations across devices while preserving variant-specific impact and routing history.
7. Observe page loads/transitions and missing-control failures without navigation during active work. Add idle audits with visible due/deferred states; never submit test prompts/uploads merely to inspect a page.
8. Add explicit baseline acceptance and compatibility verification. Reading or acknowledging an alert must not silently adopt the new baseline.

**Existing Android integration points:** `ClipperDiagnostics.kt`, `ClipperReceipt.kt`, `ClipperRun.kt`, `ClipperAi.kt`, `GeminiWeb.kt`, `GeminiSettingsDom.kt`, `AiStudio.kt`, and existing browser/profile infrastructure. Confirm the actual ChatGPT adapter entry points during Phase 0.

**Proposed additions:** a UI-monitor component, versioned provider baseline fixtures, device Image Clipper Manager forwarding adapter, and UI-change incident/detail views.

**Verification:** recorded/constructed page-state fixtures for all three websites; changed labels/layouts, missing controls, transient overlays, variants, repeated delivery, and offline replay. Primary cases: A27–A31; monitoring noninterference portion of A32.

**Exit gate:** a confirmed change on each website produces one traceable user notification via the device manager. Cosmetic changes are reported; dynamic conversation content is not treated as a redesign. Unsupported/unobserved states remain visible as unchecked.

**Rollout/rollback:** observe one device first, then all enrolled devices. Detection thresholds can be disabled per provider/variant while incidents and previous baselines are retained. No adapter self-repair is enabled here.

## 6. Phase 3 — Durable task authority and one-device pilot

**Implementation status (20 October 2026):** single-page managed Android execution, immutable upload, trusted Studio publication and crop-reader integration passed live on Nord/Saran (Free), Abhishek (Go) and Neostopzone (Plus), under the default-model policy. Go/Plus completed-task restarts passed. A real saved-before-ack result survived process exit and lease expiry, then uploaded/published through explicit saved-only reconciliation on APK 1.0.142 without a new prompt or lease reset; actual native reconciliation and post-publication process restart passed. Full ProductionRunner integration, downstream managed chapter review/cut/Editor completion, revised-input detach/rebinding and remaining unknown-submission/cancellation acceptance still block the full Phase 3 exit gate. See [current handoff](manager-agents/phase3.md) and [live evidence](manager-agents/validation.md).

**Outcome:** One supported workflow executes with durable identity, ownership, command tracking, and publication checks.

Work packages:

1. Add relay-side schema migrations for task, attempt, command, and basic resource-reservation records. Keep migrations additive and replayable.
2. Implement atomic claim, renewal, command recording, checkpoint reporting, cancellation, and conditional completion/publication. Treat clock-based freshness separately from source ordering and attempt generation.
3. Integrate task planning with `productionRunner.ts` and `productionAutomation.ts`. Starting a new run must reuse the matching task identity rather than duplicate it.
4. Extend phone protocol capabilities and correlate accepted/started/stopped/saved acknowledgments to command and attempt IDs. Persist command intent and local checkpoints before progressing.
5. Reserve the device/browser/profile used by the pilot task. Establish the account-identity reference needed for richer capacity coordination in Phase 5.
6. Stage artifacts under immutable attempt-specific references. Commit canonical metadata only after current ownership, revision, and validation checks. Importers must reject incompatible or unmanaged writes for enrolled tasks.
7. Route all pilot-workflow starts through the same ownership check. Exclude legacy phones and conflicting manual paths from managed sessions.
8. Implement pause/cancel and a read-only task timeline in Studio. Automatic failover and provider switching remain disabled.

**Existing integration points:** relay `index.ts`, `productionAutomationModel.ts`, `productionRunner.ts`, `productionAutomation.ts`, `phoneRelay.ts`, `phoneSend.ts`, the pilot import service, Android `StudioRelay.kt`, `LibraryAutomationService.kt`, `AutomationService.kt`, and the selected executor/checkpoint store.

**Proposed additions:** task-authority persistence/handlers, shared task contract codecs, local command journal, and task/attempt history projection. Avoid putting cloud ownership into an unrelated desktop `Setting` value as a second authority.

**Verification:** simultaneous claim requests, duplicated commands, crash before/after persistence boundaries, saved result with lost acknowledgment, cancelled retry, invalid publication, and schema compatibility. Cases A01, A02, A06–A10, and A23 on the pilot scope.

**Exit gate:** one-device production preserves verified work across restart; the local relay race test grants only one owner; stale attempt publication is rejected at commit time, not just hidden in the UI.

**Rollout/rollback:** enable for one explicitly enrolled device and test series. Disable new dispatch to roll back, then reconcile active attempts. Never fall back to legacy dispatch while managed work remains active or uncertain.

## 7. Phase 4 — Multi-device coordination and reconnect recovery

**Outcome:** The user's two-device stop/restart scenario behaves correctly without overlapping ownership or blind regeneration.

Work packages:

1. Replace recalculated unfinished-chapter ownership with durable per-unit assignments for the pilot workflow.
2. Implement the reconnect exchange: local attempts, pending commands/submissions, saved outputs, authoritative assignments, and explicit obsolete-attempt responses.
3. Track device liveness, task progress, and request outcome independently. A background heartbeat alone must not conceal a stalled executor.
4. Add conservative rescheduling: confirmed unsent/safely released work may move; uncertain submitted work waits for reconciliation while healthy devices take other tasks.
5. Enforce ownership checks at new action boundaries and at final artifact publication. A returning old worker cannot reclaim transferred work by replaying a command.
6. Apply shared reservation checks across Studio sessions, phone-local starts, and stage controls. Reject incompatible devices rather than silently offering incomplete protection.
7. Surface uncertain, waiting, resumed, reassigned, stop-pending, and cancelled states with precise next actions.

**Existing integration points:** the Phase 3 task authority, `productionAutomation.ts`, `productionRunner.ts`, `phoneRelay.ts`, Android relay/executor/start controls, `PhoneStatus.tsx`, `LiveProgress.tsx`, and automation dialogs.

**Verification:** scripted message loss/duplication/reordering, two simultaneous schedulers, two devices, restart during upload, lost stop acknowledgment, prolonged device pause, and cloud-authority outage. Cover A01–A10, A18, A22, and A23 for the managed scope.

**Exit gate:** demonstrate the exact sequence: Phone 1 stops → Phone 2 continues distinct work → only reconciled unfinished work transfers → Phone 1 reconnects and skips transferred/completed units. An external request with unknown outcome is never automatically repeated.

**Rollout/rollback:** two-device pilot before wider enrollment. On failure, stop new assignments and reconcile existing ones; retain completed checkpoints and incident history. Expiring leases is not a substitute for reconciling uncertain website activity.

## 8. Phase 5 — Accounts Manager and execution routing

**Source status (22 October 2026):** The requested audit/reservation/selection runtime is implemented across relay, Studio and phone for the enrolled default-ChatGPT crop workflow. Audits run under shared and local idle ownership, claims pin policies and account capacity atomically, and ineligible work waits explicitly. See the [runtime handoff](../../MAPI/Sleeper-cell-main/docs/managed-phase5-runtime.md) for tests, compatibility and remaining release gates. No Phase 5 installed-device acceptance or Phase 6 recovery enablement is claimed.

**Outcome:** Automation can select an eligible website/profile, account health is checked every 24–48 hours, and shared quotas are respected across devices.

Work packages:

1. Normalize existing profile checks and usage observations into account/profile records with observed, locally counted, estimated, owner-supplied, and unknown evidence labels.
2. Confirm cross-device account identity where supported. Keep provider/product/model/project/feature quota scopes distinct and unconfirmed matches unresolved.
3. Add scheduled audit records with default 24-hour cadence and optional 48-hour cadence. Reserve idle profile access; show busy/offline deferrals and last successful audit.
4. Add event-driven updates for quota messages, sign-outs, and capability changes, plus a brief preflight when critical evidence is stale.
5. Add stage-specific preferred/allowed provider, model, effort, profile, and quality policies. Persist the selected configuration in each attempt.
6. Coordinate profile/account-capacity reservations with task claims; release safely on completion/cancellation/reconciled failure. Local quota counters remain estimates when outside activity cannot be observed.
7. Implement ranking and waiting behavior; do not switch providers when required context cannot be restored. Passing an estimated reset time schedules a recheck.
8. Extend Accounts UI with relationships, evidence age, quota scopes, selected policies, and required actions. Route login/plan decisions to the Issues Manager.

**Existing integration points:** `phoneProfiles.ts`, `phoneReadiness.ts`, `PhoneProfile.tsx`, `AccountsStatus.tsx`, `SeriesAutomationDialog.tsx`, Android `ProfileCheck.kt`, `ChatGptUsage.kt`, `UploadLedger.kt`, `AiStudioLedger.kt`, `RemoteProfiles.kt`, and existing account/profile screens.

**Verification:** same account on two devices, stale/failed checks, busy-session audits, delayed reset, missing capability, context-incompatible fallback, and reservation races. Primary cases A12, A14–A16, A19, and A25; prepare A11/A13 for recovery integration.

**Exit gate:** an eligible profile is selected reproducibly with an inspectable reason; no eligible profile produces a clear waiting state. An account audit never steals an active session or labels an unknown account free/logged out.

**Rollout/rollback:** enable audits first, then automated initial selection, then permitted fallback eligibility. On rollback, disable new automatic selection/audits and retain the pinned configuration of existing attempts; ownership protection stays enabled.

## 9. Phase 6 — Automatic diagnosis and bounded recovery

**Outcome:** Recognized stops lead to verified recovery and checkpoint resume, with unresolved conditions escalated to the owner.

Work packages:

1. Create one recovery controller within the Automation Manager with a shared error taxonomy, evidence references, retry budget, and persisted recovery state.
2. Assign recovery ownership for each operation. Existing nested retries must be incorporated into the budget or disabled so several layers cannot independently repeat an action.
3. Implement playbooks in this order: safe local/import/transfer retries; quota waiting and account eligibility; session/sign-out handling; known UI recovery; validated output-correction flows.
4. Distinguish provider upload allowance from transport failure, unsupported attachment, or cloud failure before choosing a remedy.
5. Connect UI Monitor compatibility evidence through the Device Image Clipper Manager. Reuse the same incident as a missing-button failure; the monitor never dispatches recovery.
6. Require postcondition checks after every recovery: correct page/profile, attachment actually present, acknowledged command, or validated artifact.
7. Implement bounded delays and attempt counts from the PRD, cancellation precedence, scope-specific cooldowns, and stopping a repeatedly failing adapter without blocking unrelated work.
8. Preserve provider conversation/checkpoint context for allowed fallback. Hold ambiguous submissions and report the required decision rather than treating every timeout as retryable.
9. Add recovery timeline and actions to Studio, including recheck, resume after a confirmed repair, and explicit handling of unresolved outcomes.

**Existing integration points:** production runner/execution, task/incident services from prior phases, Android automation executors, popup/page-state handling, quota/reset parsing, transfer/import services, and module validators.

**Verification:** fault-injected playbooks for every REC-02 failure row, including quota exhaustion, upload exhaustion, sign-out, missing button, late output, and lost acknowledgment. Primary cases A03, A04, A09, A11, A13, A14, A17, A18, A20, A21, A25, and A32.

**Exit gate:** each enabled playbook has a known trigger, evidence requirements, permitted actions, retry ceiling, postcondition, and escalation path. No recovery proceeds through a user pause or uncertain external submission. Repaired work resumes at the verified unfinished unit.

**Rollout/rollback:** enable one playbook/provider/workflow combination at a time. A recovery kill switch stops new repair actions but continues recording outcomes and incidents. It must not cancel evidence collection or erase in-flight attempts.

## 10. Phase 7 — Complete module coverage and Studio experience

**Outcome:** All supported production modules use the shared status and execution contracts rather than only the pilot workflow.

Work packages:

1. Extend task/checkpoint ownership to narration, voiceover sections, clipping pages, staged Editor batches, and eligible desktop jobs. Respect narrative order and language-specific dependencies.
2. Complete validators and availability reporting for download/preparation, script/audio import, alignment, clipping/review, Editor processing, exports, and storage.
3. Apply revision invalidation consistently to page replacement, script replacement, regenerated audio, prompt changes, and dependent timeline/export work.
4. Preserve existing manual review, manual part marks, archive/cleanup behavior, and completed artifact retention. Do not make storage cleanup an automatic production recovery action.
5. Integrate every existing start/stop/resume entry point with shared ownership; remove shadow scheduling paths only after compatibility checks pass.
6. Complete the operations overview, task timeline, Accounts view, Issues inbox, manager freshness, and website UI details within existing screens.
7. Add bottleneck explanations: who owns the next step, required input/location, last evidence, and next scheduled or manual action.

**Existing integration points:** all relevant `server/src/services` module validators and routes, `librarySync.ts`, `chapterPageReplacement.ts`, `scriptReplacement.ts`, `editorWorkflowStore.ts`, `editor2Export.ts`, `storageService.ts`, client module pages/hooks, Android production modules and `EditorStages.kt`.

**Verification:** complete both-language journeys with selected chapters, revised inputs, missing files, delayed imports, required review, export/re-export, and stored/archived results. A07, A10, A21, A22, A25, A26, and earlier ownership/recovery cases must now pass for every enrolled workflow, not only the pilot.

**Exit gate:** every role in PRD Section 5 has an implemented owner, observation source, health indicator, and incident route. The same chapter/revision shows consistent facts across Library, Narration, Clipper, Editor, and device views.

**Rollout/rollback:** enable workflow coverage incrementally. Unsupported paths remain explicitly outside managed concurrent runs; rollback pauses that workflow's new dispatch while preserving shared task and artifact history.

## 11. Phase 8 — Migration rehearsal, failure testing, and rollout

**Outcome:** The release meets all deterministic acceptance scenarios and can be operated and rolled back without losing work.

Work packages:

1. Run migrations on copies of desktop and relay data, preserving legacy IDs, revision evidence, and known outputs. Verify repeat application and restart recovery.
2. Import existing work conservatively: verified outputs become completion evidence; old receipts without required provenance remain last-known/unknown; old running commands remain interrupted or uncertain until reconciled.
3. Exercise every PRD acceptance case A01–A32 with deterministic fixtures/local services before using real production accounts.
4. Measure status latency, cloud operation volume, payload size, device overhead, account audit deferrals, recovery results, and duplicate/stale-publication rejection.
5. Release relay protocol support first with managed dispatch disabled. Then release the compatible Studio client and phone build. Enroll only devices advertising the required protocol capabilities.
6. Pilot in steps: observation only → one managed device → two devices → each permitted recovery playbook → additional supported workflows/devices.
7. Perform a supervised run including at least one disconnect/reconnect, one saved-result/acknowledgment interruption, one quota/sign-out simulation, and one UI-change fixture. Do not consume paid capacity solely to recreate failures already covered by fixtures.
8. Write operator procedures for manager outage, uncertain request, login repair, UI-baseline review, pausing recovery, data backup, and compatible rollback.

**Exit gate:** all A01–A32 pass; no simultaneous valid ownership or accepted stale publication is observed; uncertainty never causes a blind replay; UI-change notifications follow the required chain; resource budgets are documented from measurements; rollback rehearsal preserves work.

**Release artifacts:** compatibility matrix, migration notes, acceptance evidence, known limitations, operator runbook, and per-feature enablement settings.

**Rollback sequence:** stop new claims → request stops where possible → reconcile or retain uncertain attempts → preserve checkpoints/artifacts/outboxes → disable affected execution/recovery paths → revert only to a protocol-compatible release. Do not restore an old database snapshot or enable legacy dispatch over active newer assignments.

## 12. Phase 9 — Optional AI-assisted diagnosis

This phase is not required for the core release.

1. Add an explicitly enabled diagnostic adapter receiving limited, redacted incident evidence.
2. Enforce usage limits, evidence retention, and recorded explanations.
3. Present suggestions as advisory; only existing deterministic playbooks may execute permitted actions.
4. Evaluate unfamiliar-page/error interpretation using recorded examples with known outcomes.
5. Verify that disabling the adapter leaves scheduling, accounts, UI monitoring, and recovery functional.

**Exit gate:** advice is useful and attributable without controlling task ownership, verified facts, source-code changes, or uncertain-request resubmission. PRD A24 passes with the feature enabled, disabled, failing, and unavailable.

**Rollback:** disable the diagnostic adapter; retain the underlying evidence and incident history. No core service depends on it.

## 13. Validation strategy and repository constraints

Tests listed below are implementation work, not commands run while preparing this plan.

| Layer | Validation approach | Existing starting points |
|---|---|---|
| Shared contracts | Valid/invalid message fixtures and compatible TypeScript/Kotlin decoding | New fixtures defined in Phase 0 |
| Server policies | Vitest for transitions, planning, aggregation, selection, invalidation, and bounded recovery | `server/src/services/__tests__/productionAutomation*.test.ts`, `phoneRelay*.test.ts`, `seriesProcess*.test.ts`, replacement/import tests |
| Relay authority | Local concurrency, conditional completion, persistence/restart, acknowledgment, and replay tests | `relay/scripts/library-sync-check.mjs`; add managed-task scenarios without writing to production |
| Android execution | Unit tests for checkpoints, account observations, ownership boundaries, and recovery classification | `app/src/test/...`, `QuotaResetTest.kt`, `AiStudioErrorsTest.kt`, `LibraryAutomationModelTest.kt` |
| Website adapters | Recorded/constructed structure and screenshot fixtures; supported variant and transient-state cases | Existing `tools/test_popup_scripts.mjs`, `test_gemini_settings.mjs`, and editor recovery scripts |
| Studio UI | Focused tests for status distinctions, route/action availability, deduplicated notifications, and pause behavior | Existing client hooks/components and associated test conventions |
| Integration | Mac + local relay + simulated phones, followed by compatible real-device pilot | Phase 4/8 failure matrix |

Planned commands use each repository's existing scripts:

| Working directory | Command/purpose |
|---|---|
| `server/` | `npm test -- <relevant-test-files>` for focused policy tests; `npm run build` for server compilation |
| `relay/` | `npm run typecheck`; local Wrangler session and local-only integration scripts |
| Studio root | `npm run build` when integrated server/client changes require it |
| Sleeper-Cell root | `./gradlew testDebugUnitTest --offline` and relevant existing Node script checks |

Per the [Android workspace instructions](../../MAPI/Sleeper-cell-main/AGENTS.md), APK builds use GitHub Actions. Do not generate APKs locally or install a local build as part of this plan. Any later live-device pilot uses an appropriately released compatible build.

Use deterministic clocks and message-loss/reordering controls in coordinator tests. Fault-injection cases must assert accepted effects and saved outcomes, not only logs or internal method calls. Tests must not upload private production evidence or access live accounts by default.

## 14. Traceability and completion checklist

| PRD requirements | Main implementation phases |
|---|---|
| STATE-01–STATE-07 | 0, 1, 7, 8 |
| AUTO-01–AUTO-05 | 0, 3, 4, 5 |
| AUTO-06–AUTO-13 | 3, 4, 6, 7, 8 |
| REC-01–REC-06 | 6, 7, 8 |
| UI-01–UI-07 | 2, 6, 8 |
| ACC-01–ACC-08 | 1 observation, 5 implementation, 6 recovery integration |
| ISS-01–ISS-06 | 1 foundation, 2 UI routing, 6 recovery history, 8 verification |
| PRD nonfunctional targets | Baseline in 0; measure in 1–7; enforce release gate in 8 |
| Optional AI assistance | 9 only; absence verified throughout core phases |

Before marking the core implementation complete:

- [ ] All 12 shared roles and 9 per-device roles have mapped responsibilities and health reporting.
- [ ] Existing execution entry points participate in ownership checks or are explicitly excluded.
- [ ] A01–A32 pass across all enrolled workflows and supported website variants.
- [ ] Two-device interruption/resume has been demonstrated without conflicting accepted work.
- [ ] Quota, upload, sign-out, and missing-button recoveries obey evidence, policy, and retry limits.
- [ ] Account audits and UI monitoring do not steal active browser sessions.
- [ ] UI changes reach the user through the device Image Clipper Manager and Issues Manager.
- [ ] Older input revisions, stale attempts, and delayed receipts cannot override current valid results.
- [ ] Pause/cancel, manual review, and uncertain-request holds remain effective during failures.
- [ ] Compatibility, migration, measured budgets, known limitations, and rollback are documented.
- [ ] Optional AI can remain disabled with no loss of core functionality.

## 15. First implementation milestone

Start with Phase 0, then deliver Phase 1 observation and the Issues inbox. The first visible milestone is a chapter view that accurately explains its latest verified state, missing handoff, responsible manager, and source freshness. Add the website UI reporting chain next while durable task ownership is developed separately.

Automatic restart/failover is enabled only after the ownership, reconnect, and account-policy gates pass. Completing this planning document does not authorize or perform application implementation, deployment, or device changes.
