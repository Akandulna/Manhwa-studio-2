# PRD: Manager Agents and Reliable Automation

**24 October continuation update:** Read the [completed agent-reporting and Cloudflare usage scope](../../MAPI/Sleeper-cell-main/docs/agent-reporting-continuation-update.md) before continuing overlapping work. Source implementation and local validation are complete; rollout, installed acceptance and measured savings remain pending. Reconcile older pending items with that update; reuse the delivered implementation rather than starting it again. Other phase gates remain unchanged.

**Product:** Manhwa Studio + Sleeper-Cell + Cloudflare relay  
**Version:** 1.2 — requirements with implementation status\
**Date:** 24 October 2026 (original: 18 October 2026)\
**Status:** Implementation is in progress. Scoped Phase 4/5 acceptance and later source milestones are tracked in the implementation plan. Cloudflare/agent traffic reductions are implemented and locally validated as of 24 October; compatible deployment, installed-device acceptance and production usage measurement remain pending. This does not establish full Phase 6 or overall product acceptance.\
**Implementation plan:** [Phased delivery plan](IMPLEMENTATION-PLAN-manager-agents-and-automation.md)  
**Primary user:** The studio owner operating a Mac and multiple Android production devices

## 1. Product intent

Give every production module a clear software owner that knows what is happening, verifies its outputs, coordinates handoffs, and reports problems. Give the owner one trustworthy view of production across the Mac, phones, and cloud.

These agents are rule-based components of the existing applications and relay. Their core behavior requires no language model or AI API. They supervise the AI websites already used for production. Optional AI assistance may later help diagnose unfamiliar failures.

The central promise is:

> Every task can explain its current owner, progress, input revision, output locations, blocker, and next action. Interrupted automation resumes from verified progress without knowingly duplicating active or completed work.

The Automation Manager must also diagnose known failure types and recover automatically when the cause and recovery are sufficiently verified. Repeatedly restarting an entire run is not an acceptable recovery strategy.

## 2. Problem and existing foundation

Production state currently spans local database records, files, phone receipts, cloud objects, browser sessions, and automation jobs. A completed stage on one device does not necessarily mean the latest output is available to the next module.

The existing application already has useful foundations:

- A production model covering 20 stages, including language-specific work.
- Shared library synchronization, phone receipts, reconnect handling, and multi-device progress aggregation.
- Production jobs, distinct chapter allocations, prerequisites, and device overlap checks within the existing runner.
- Restart handling that marks running jobs interrupted rather than blindly replaying commands.
- Profile selection, capability information, and account observations reported by phones.
- Revision protection and checkpointing in some workflows, including staged Editor timelines.

The inspected production job model records command recipients but does not provide the complete per-task ownership, acknowledgment, and recovery contract required here. Current safeguards must be preserved while responsibilities are standardized.

This document describes proposed behavior. It does not claim that all requirements already exist, or that every observed synchronization problem has been diagnosed.

## 3. Goals and scope

### Goals

1. Show consistent, evidence-backed status across every participating module and device.
2. Prevent conflicting task assignments, including after phone, desktop, or relay restarts.
3. Resume the smallest verified unfinished unit without repeating completed work.
4. Recover automatically from recognized transient, account, quota, upload, and interface failures.
5. Select suitable devices, websites, models, and profiles using explicit owner preferences.
6. Audit account health every 24–48 hours and react to failures discovered during production.
7. Present one actionable incident per underlying problem, with recovery history.
8. Preserve existing review gates, content revisions, and user stop/pause decisions.
9. Detect website UI changes in ChatGPT, Gemini, and Google AI Studio and report them through the device Image Clipper Manager to the Issues Manager and owner.

### In scope

Library/downloads, page preparation, narration, voiceover, alignment, clipping/review, Editor timelines, exports, storage availability, device readiness, account capacity, cloud transfers, automation scheduling, recovery, website UI monitoring, and issue reporting.

### Out of scope

- Replacing the production engines, editors, or AI websites.
- Requiring an LLM for scheduling, locking, completion, account verification, or routine recovery.
- Creating a separate process or service for every logical agent.
- Promising exactly-once execution of requests submitted to third-party websites.
- Automatically purchasing subscriptions or changing billing settings.
- Autonomous source-code modification or deployment to repair a website adapter.
- Eliminating human login verification, ambiguous-result decisions, or existing content review.
- Unrequested email, chat, or push integrations. Initial reporting is inside Studio.

## 4. Primary user journeys

| Journey | Expected outcome |
|---|---|
| Start production with two phones | Eligible work is divided into distinct owned tasks; each assignment records its website and profile. |
| One phone disconnects | Other phones continue unrelated work. Uncertain work is reconciled before reassignment. |
| A stopped phone returns | It checks current assignments before resuming and skips work now owned or completed elsewhere. |
| A quota or upload allowance is exhausted | Affected capacity is marked unavailable; automation uses an allowed eligible alternative or waits for a verified recheck. |
| An account signs out | Its profile becomes unavailable, an incident requests login, and independent work continues where possible. |
| An expected button is missing | Automation checks page state and known interface variants, attempts bounded recovery, then reports evidence if unresolved. |
| ChatGPT, Gemini, or Google AI Studio changes its UI | The Website UI Monitor Agent captures the observed change, reports to that device's Image Clipper Manager, and the Issues Manager informs the owner with impact and evidence. |
| A script or page revision changes | Dependent results become outdated; unrelated valid work remains usable. |
| The owner returns after an unattended run | Studio shows completed work, outstanding blockers, automatic recoveries, and actions requiring the owner. |

## 5. Manager organization and ownership

The hierarchy represents responsibilities and reporting relationships. Managers share authoritative records; each must not maintain an independent competing version of production truth.

### Shared roles: 12

| Role | Primary responsibility | Execution boundary |
|---|---|---|
| Manhwa Studio Manager | Overall health, dependency readiness, module coordination, owner overview | Mac backend and Studio UI |
| Device Fleet Manager | Device presence, capabilities, compatibility, battery/network readiness, observed runs | Shared device registry with phone reports |
| Cloudflare Manager | Cloud artifact availability, relay delivery evidence, transfer reconciliation | Relay/cloud service and existing transfer adapters |
| Issues Manager | Incident grouping, impact, recovery history, owner actions, resolution | Persistent shared records, presented in Studio |
| Library & Download Manager | Catalog, download ownership, missing chapters, download status | Mac backend |
| Page Preparation Manager | Cleanup, stitching, splitting, prepared-page revisions | Mac backend |
| Narration & Alignment Manager | Script/audio imports, language-specific compatibility, alignment | Mac backend |
| Image Clipper Manager | Crop data, page compatibility, review, final cropped outputs | Mac backend |
| Editor & Export Manager | Required inputs, timeline validity, processing, renders, re-export readiness | Mac backend |
| Storage Manager | File availability, disk capacity, archive and cleanup eligibility | Mac backend |
| Automation Manager | Sole logical authority for task dispatch, ownership, sequencing, retries, recovery, and execution policy | Durable shared task authority with Mac/phone executors |
| Accounts Manager | Account/profile inventory, capabilities, scoped quotas, health audits, eligibility | Shared records with local profile checks |

The Automation Manager owns task assignments. The Fleet Manager does not independently reassign work. The Accounts Manager owns capacity eligibility and reservation records; the Automation Manager coordinates those reservations with assignments. Module managers validate outputs. The Issues Manager does not dispatch production work.

### Per-device roles: 9 on each phone

| Role | Responsibility |
|---|---|
| Device Manager | Local supervision, readiness, current commands, checkpoints, and reconnect reconciliation |
| Library & Preparation Agent | Local chapters, downloads, prepared inputs, revisions |
| Narration Agent | Scripts, language status, continuity, review requirements |
| Voiceover Agent | Splits, audio sections, script compatibility, saved outputs |
| Device Image Clipper Manager | Page work, crop JSON, review status, revision compatibility; receives website UI-change reports, assesses clipping impact, and forwards them to the Issues Manager |
| Editor Agent | Packages, prerequisites, staged checkpoints, generated timelines |
| Accounts & Capacity Agent | Local login/plan/capability observations and profile availability |
| Sync Agent | Local transfer queue, acknowledgments, retries, verification |
| Website UI Monitor Agent | Observes ChatGPT, Gemini, and Google AI Studio UI on this device, compares against known baselines, and reports changes to the Device Image Clipper Manager |

The Device Image Clipper Manager is the previously named Clipping Agent with an explicit supervisory responsibility; it is not an additional role. The Website UI Monitor Agent is one new role type, instantiated once per phone and covering all three websites rather than one agent per website.

**Role count: 12 + 9 × participating phones.** One phone gives 21 roles; two give 30; three give 39. Chapters, pages, languages, and accounts are managed records, not additional agents.

**Website UI reporting path:** Website UI Monitor Agent → Device Image Clipper Manager on the same phone → Issues Manager → owner. The Automation Manager remains the sole task dispatcher and recovery authority.

## 6. Common reporting contract

**STATE-01 — Separate facts.** Every relevant view must distinguish:

1. Work state: queued, running, waiting, uncertain, awaiting review, failed, or verified complete.
2. Availability: produced locally, uploaded, downloaded, imported, and validated at each required destination.
3. Revision compatibility: whether the result matches its current dependencies and execution specification.
4. Freshness: when the originating component last confirmed the fact.

**STATE-02 — Evidence and provenance.** Reports must include stable entity identity, source device/module, source revision or sequence, observed time, received time, and evidence references. A dashboard refresh must not refresh the apparent age of old phone evidence.

**STATE-03 — Clear authority.** The module that validates a stage owns its completion evidence. Cloud storage confirms cloud availability; it does not establish desktop import, content quality, or local readiness.

**STATE-04 — Ordered updates.** Duplicate or delayed messages must not undo newer accepted facts. Completion from an older input revision cannot satisfy current work. Stable entity IDs must work across devices; display names and folder names alone are insufficient identity.

**STATE-05 — Invalidations.** Page, script, audio, prompt, or other material dependency changes invalidate affected downstream results. Historical artifacts and evidence remain distinguishable from current valid output.

**STATE-06 — Reconciliation.** Compare records with actual artifacts on startup, reconnect, relevant changes, and bounded scheduled checks. Detect missing files, interrupted transfers, stale records, and results saved before an acknowledgment was lost.

**STATE-07 — Independent incidents.** Overall completion must not hide device-specific failures. Manual part-completion marks remain explicit overrides and must not fabricate artifacts or validate unfinished automation tasks.

## 7. Automation coordination requirements

### Task identity and dispatch

**AUTO-01 — Stable task identity.** A task identifies series, chapter, stage, language where applicable, recoverable unit, and required input/configuration fingerprint. A run ID groups tasks but is not their sole identity. Starting another run must discover an existing matching task.

Recoverable units follow the workflow: a voiceover section, crop page, staged Editor batch, or chapter where finer checkpoints are unavailable. Narration dependencies must preserve reading order and required preceding summaries.

**AUTO-02 — Atomic ownership.** Claiming a task must atomically establish its owner and attempt version. Concurrent requests from phones or multiple Studio instances cannot both become its current owner. One logical authority governs assignments even if several processes connect to it.

**AUTO-03 — Execution configuration.** Save the assigned device, account/profile, provider/product, model/settings, prompt/dependency fingerprint, and approved fallback policy. Changes affecting output compatibility require explicit revision handling.

**AUTO-04 — Resource reservations.** Reserve task ownership and required device/browser/profile capacity without leaving partially acquired resources available to conflicting work. Shared account quotas must be coordinated across profiles and devices. Reservations are internal capacity estimates, not a claim to reserve capacity at the provider.

**AUTO-05 — Correlated acknowledgments.** Track command queued, accepted, started, result saved, result verified, and stop requested/confirmed. Each acknowledgment identifies the task, attempt, and command. A connected socket or a successful send is not acceptance or execution proof.

### Ownership lifecycle and recovery

**AUTO-06 — Renewable ownership.** Active owners renew bounded ownership using the authoritative service. Device reachability and actual task progress are separate signals. A healthy heartbeat must not conceal a stalled task.

**AUTO-07 — Stale-owner protection.** A returning or delayed worker cannot act on an obsolete assignment or publish it as current. Publication must verify ownership and revision at the commit point. Large artifacts may be staged first; only validated current metadata may make them canonical. Superseded outputs may be retained for reconciliation, not silently installed.

**AUTO-08 — Safe reassignment.** Missed heartbeats or ownership expiry do not prove an external request failed. Work can move only when the prior attempt is reconciled and the specific action is safe to repeat. Confirmed unsent work can be reassigned; uncertain submitted work is held.

**AUTO-09 — Reconnect handshake.** Before continuing automation, a phone reports local attempts, pending submissions, checkpoints, and saved outputs, then receives current assignments. It must not resume an old local chapter list automatically.

**AUTO-10 — Persist before progressing.** Save accepted checkpoints and pending command intent durably. If a result was saved but its acknowledgment was lost, recovery validates and reuses it. Completion requires defined evidence; no acknowledgment-only shortcut may mark an artifact complete.

**AUTO-11 — Resume semantics.** Resume reconciles the existing task graph. It skips valid completed units, respects active ownership, and schedules only eligible unfinished units. If a result cannot be recovered safely, retain the uncertainty and report the decision needed.

**AUTO-12 — Pause and stop.** Owner pause/cancel requests override automatic recovery. Stop remains pending until confirmed or reconciled. Restarting a manager must not resurrect cancelled work. Unrelated healthy tasks continue unless their dependency or shared resource is affected.

**AUTO-13 — Offline behavior.** When shared ownership cannot be verified, devices do not begin new externally consequential work. Already submitted requests may finish; their results are retained for reconciliation. Desktop-only work waits while the Mac is unavailable. Phone automation may continue without the Mac only for previously authorized work supported by the shared coordinator and available prerequisites.

### Illustrative task lifecycle

| State | Meaning | Permitted next action |
|---|---|---|
| Queued | Eligible or waiting for prerequisites/capacity | Claim when dependencies and resources are ready |
| Assigned | Ownership recorded; device acceptance pending | Await correlated acceptance or reconcile dispatch |
| Running | Accepted execution with current ownership | Checkpoint, report progress, or enter recovery |
| Uncertain | Outcome or current execution cannot be established | Reconcile; do not blindly resubmit |
| Recovering | A bounded recovery plan is active | Verify its outcome before resuming |
| Waiting | Known dependency, quota, account, or owner action blocks work | Recheck at the recorded condition/time |
| Awaiting review | Required human/content review is outstanding | Continue only after the existing review decision |
| Verified complete | Current output satisfies stage requirements | Release capacity and enable dependents |
| Failed | Recovery exhausted or nonrecoverable error confirmed | Report actionable next step |
| Cancelled / superseded | Owner cancelled or inputs were replaced | Retain history; never automatically resume this attempt |

Transfer and source-freshness states remain separate from this lifecycle.

## 8. Automatic diagnosis and recovery

The Automation Manager owns a recovery subsystem; this does not add another independently dispatching agent.

**REC-01 — Diagnosis loop:** detect missing progress or a reported error → collect evidence → classify cause → select a permitted recovery → execute within limits → verify → resume from checkpoint or escalate.

Evidence may include the last successful step, command outcome, page URL/state, accessible page structure, relevant error text, local file/transfer status, account observations, and a redacted screenshot when useful. Timeout alone is not proof of a specific cause.

**REC-02 — Recovery playbooks.** Initial required behavior:

| Failure | Required checks | Automatic response | When owner action is required |
|---|---|---|---|
| Generation quota exhausted | Identify the affected account/product/model quota and any displayed reset | Update Accounts Manager; use an approved eligible alternative or wait for recheck; preserve context and checkpoints | No permitted alternative and no reliable recovery condition, or a plan decision is needed |
| Upload allowance exhausted | Distinguish provider allowance from oversized/unsupported file, network error, or cloud transfer failure | Respect the affected quota; wait or use an allowed profile with independent eligible capacity; retry only a verified incomplete upload | Input changes or an account decision is required |
| Account signed out / session expired | Verify a sign-in state; do not infer logout from a timeout | Mark the profile unavailable, preserve the task, use an allowed alternative where context can be restored | Login, verification, or session repair cannot complete through an already authorized mechanism |
| Button not found | Check expected page, loading state, login/quota overlays, supported UI variants, and whether the preceding action already succeeded | Wait for readiness; use known semantic alternatives; dismiss recognized noncritical overlays; reload/reopen only when pending actions are reconciled | Target remains ambiguous or the website adapter needs a code change |
| Network timeout | Establish whether the request was unsent, explicitly rejected, completed, or uncertain | Retry safe transfer/navigation operations with backoff; hold uncertain submitted generation | Outcome remains unresolved beyond the task's recovery budget |
| Browser/app stopped | Read durable attempt and checkpoint records; inspect restored session/output | Restore a known state, reconcile outstanding work, resume the first eligible unit | Session/context or outcome cannot be recovered |
| Output malformed or missing required fields | Validate against the stage's schema and required inputs | Use the workflow's bounded correction/regeneration policy; keep accepted units | Validation still fails or content review is required |
| Cloud upload/import failed | Compare local output, cloud object/version, and destination acknowledgment | Retry the missing transfer/import step; retain generated content | Credentials, capacity, or persistent storage problems block recovery |
| Device unavailable | Separate loss of reachability from confirmed stopped execution | Continue healthy devices; transfer only safely released work | Uncertain external requests cannot be reconciled |

**REC-03 — Verify the recovery.** A page reload, profile switch, or retry succeeding is not enough. Verify the intended postcondition: correct page, eligible profile, actual uploaded attachment, accepted command, or valid saved output.

**REC-04 — Bounded attempts.** Proposed initial defaults are three transient recovery attempts with increasing delays and jitter, and at most two known UI-recovery cycles for the same failure. These are configurable product defaults to validate during implementation. They do not authorize three repeats of an uncertain generation request.

Quota waits use provider evidence where available. Passing an estimated reset time makes capacity eligible for recheck, not automatically available. Persistent failure disables the affected recovery path until new evidence or owner action changes the condition.

**REC-05 — Recovery scope.** Block the smallest affected resource or task set. A broken provider adapter may pause its relevant stages across devices, while unrelated providers and local work continue.

**REC-06 — No silent destructive repair.** Recovery must not delete verified outputs, clear working browser sessions, change billing, bypass review gates, or rewrite application code. An explicit rerun of uncertain work must explain the possible duplicate request and record the owner's decision.

### Website UI monitoring

**UI-01 — Coverage.** One Website UI Monitor Agent per phone observes the supported ChatGPT, Gemini, and Google AI Studio pages used by automation. Track changes to layout, labels, icons, control presence and location, input/upload controls, model selection, dialogs, response actions, and navigation. Detection applies to pages and states actually observed; an unvisited or inaccessible page must not be presented as recently checked.

**UI-02 — Baselines and evidence.** Maintain versioned known baselines for the relevant website, workflow/page state, device viewport, locale, theme, and observed profile variant. Compare accessible page structure and targeted visual evidence where available. A report includes website, device/profile reference, page/workflow, baseline version, last matching observation, first changed observation, expected versus observed UI, and redacted before/after evidence when available. Initial observations without a baseline establish coverage pending validation, not a claim that the website has changed.

**UI-03 — Check timing.** Observe normal page loads and relevant UI transitions during use, perform a lightweight check before a workflow uses its required controls, and check again after a missing-button or unexpected-page failure. Also schedule an idle audit once daily by default, configurable to 48 hours. Defer checks that require navigation or switching an active session; expose pending and last-checked status. Monitoring must not submit prompts, consume uploads, reload pending generation, or interfere with active automation merely to inspect the UI.

**UI-04 — Confirm and classify changes.** Distinguish UI changes from ordinary conversation content, streaming text, timestamps, loading states, and known session/quota overlays. Reobserve suspected changes in a stable comparable state when possible. Report confirmed cosmetic changes as informational, potential compatibility changes as warnings, and missing/ambiguous required controls as blocking for the affected workflow. If confirmation is impossible, report the observation as suspected/unknown rather than asserting a confirmed redesign. Keep device/profile-specific variants scoped to the evidence.

**UI-05 — Required escalation path.** Send each new confirmed UI change, including cosmetic changes, to the same phone's Device Image Clipper Manager. That manager attaches clipping impact and affected tasks, then forwards the report to the Issues Manager even if clipping still works. It also forwards suspected blocking changes with their uncertainty. The Issues Manager must inform the owner through an in-app notification and durable incident entry. Deduplicate repeated observations while preserving all affected devices and the full reporting chain. Cosmetic changes must not disappear solely because no automation failed.

**UI-06 — Coordination with recovery.** The monitor reports observations and does not repair adapters, click unfamiliar controls, or dispatch work. The Device Image Clipper Manager exposes a compatibility blocker for affected clipping work and provides the evidence to the Automation Manager. Other affected module managers receive linked compatibility evidence where relevant. The Automation Manager applies the existing bounded recovery and ownership rules; it may continue unaffected work. UI monitoring and a missing-button failure must update the same underlying incident rather than generate competing recovery loops.

**UI-07 — Reconnection and baseline updates.** Persist reports until the Device Image Clipper Manager and Issues Manager acknowledge receipt; replay them on reconnect without duplicate user alerts. Retain the prior baseline until the new UI is explicitly accepted through a validated adapter update or recorded owner review. Acknowledging a notification alone does not establish compatibility, clear a blocking condition, or silently replace the baseline. Baseline acceptance must be tied to the specific page/profile variant and evidence.

## 9. Accounts and execution-selection requirements

**ACC-01 — Separate account and profile identity.** A profile is a device-local browser session; an account may appear in several profiles. Group confirmed account matches and keep uncertain matches unresolved. Quotas retain the applicable provider/product/model/project/feature scope.

**ACC-02 — Inventory.** Track display identity, device/profile references, login observations, observed plan, available capabilities, quota categories, reported usage/reset, locally counted usage, current reservations, last check, and required action. Store renewal dates only when observed from a dependable source or supplied by the owner.

**ACC-03 — Evidence labels.** Values must be labeled observed, locally counted, estimated, owner supplied, or unknown. Local usage does not include activity outside this system. Missing paid-plan indicators do not establish a free plan. Failed checks do not establish logout.

**ACC-04 — Scheduled audits.** Default to one full audit every 24 hours, configurable to 48 hours. Spread checks across idle periods. Offline or busy devices retain a due/pending audit; checks run when eligible and the overdue state stays visible. Account audits must not switch a profile actively used by automation.

**ACC-05 — Event and preflight updates.** Record login/quota/capability errors immediately during normal runs. Before starting work, confirm critical readiness when cached evidence is stale or uncertain. Avoid repeatedly opening every account page for every task.

**ACC-06 — Eligibility and ranking.** Filter by required capability, login readiness, quota state, device/profile availability, context portability, and owner restrictions. Rank eligible options by the owner's preference order and available capacity. Paid status alone is not proof of suitability.

**ACC-07 — Approved fallbacks.** Each stage can specify preferred and allowed websites/models/profiles and whether to wait when none qualify. No silent quality downgrade, provider change outside policy, or loss of required narrative context. Switching profiles of the same account does not reset its shared quota.

**ACC-08 — Sessions.** Keep passwords, cookies, session tokens, and authentication secrets on the appropriate secured device/service. Shared records contain status and references. Login and verification requirements become owner actions when automatic continuation is unavailable.

## 10. Issues Manager requirements

**ISS-01 — Incident contract.** Record incident ID, type, severity, affected entities, confirmed facts, suspected cause, source evidence, first/last occurrence, responsible manager, attempted recoveries, current blocker, and next action.

**ISS-02 — Grouping.** Group repeated failures by underlying cause and resource. One exhausted account shared by three phones should produce one incident with three affected profiles, not repeated independent alerts. Device-specific details remain inspectable.

**ISS-03 — Lifecycle.** Support detected, recovering, waiting, action required, resolved, and acknowledged. Acknowledging does not resolve the condition. Verified successful recovery resolves the incident; recurrence reopens or links it.

**ISS-04 — Notification policy.** Every failure and recovery is recorded. Routine recovered incidents appear in history/digest. Show an immediate in-app alert when owner action is required, recovery is exhausted, or output integrity is threatened. Planned quota waiting without an available action is visible without repeated alerts.

Website UI changes additionally follow UI-05: every new confirmed change receives an in-app notification, with informational severity for cosmetic changes. Repeated observations update the existing entry. Notifications queued while Studio is offline are shown on reconnect.

**ISS-05 — Useful reporting.** Explain impact and action in plain language, with links to the relevant task, device, account, or chapter. Example:

> Profile B on Phone 2 needs sign-in. Four voiceover sections are waiting. Phone 1 continues its assigned work. No generation request has been repeated. Sign in, then select Recheck to resume eligible tasks.

**ISS-06 — Durable visibility.** Persist incidents while the Mac is offline and show them on reconnect. Display stale/unavailable manager reporting explicitly so a stopped Issues Manager is not mistaken for a healthy system with no issues.

## 11. User experience

Extend existing Studio surfaces before adding redundant dashboards:

- **Operations overview:** overall health, running/waiting work, devices, unresolved incidents, and last confirmed updates.
- **Automation view:** task owner, stage/unit, selected website/model/profile, checkpoint, recovery action, dependency, and retry history. Controls include pause, stop, reconcile/resume, and recheck.
- **Accounts view:** account-to-profile relationships, observed plan/capabilities, quota evidence, last/next audit, reservations, and required action. Allow preferred/fallback policy editing.
- **Issues inbox:** grouped incidents with severity, impact, recovery history, resolution, and action links.
- **Website UI status within device/clipping details:** last checks for ChatGPT, Gemini, and Google AI Studio, baseline/variant, detected changes, compatibility impact, and a link to the routed incident. No UI change detected and not checked must be distinct states.
- **Existing module views:** consistent status and revision indicators derived from the same contracts, with a clear explanation of why work is blocked.

The owner must be able to distinguish automatic recovery, waiting for capacity, waiting for another module, waiting for review, and uncertain execution. Technical logs are available as supporting detail rather than the main explanation.

## 12. Proposed architecture and integration boundaries

Use one authoritative durable store for task ownership, attempt versions, command acknowledgment state, shared account reservations, and incidents. The existing Cloudflare Worker/Durable Object relay is the preferred integration point, subject to implementation review. R2 stores artifacts and catch-up material; a loose status JSON file must not be the task-claim mechanism.

Keep local checkpoints and durable outbound updates on devices. Reconnect replays pending updates with deduplication, then reconciles actual state. Use explicit schema/capability versions and reject obsolete ownership commands.

Build the Automation Manager around the existing production runner and executors. Avoid a second independent scheduler. Existing manual start paths must participate in the same ownership/resource checks; if a legacy client cannot do so, it cannot join managed concurrent automation. External manual activity that cannot be observed must remain an explicit limitation, not be represented as coordinated work.

The implementation must define the exact task authority, persistence/commit boundaries, ownership renewal and expiry behavior, artifact publication checks, quota reservation behavior, and failure recovery before enabling automatic failover.

## 13. AI assistance policy

Core coordination, quota handling, account checks, state validation, and known recovery playbooks require no AI API.

Optional later assistance may summarize incidents, interpret an unfamiliar error page or redacted screenshot, and suggest a diagnosis or adapter change. It must have an explicit enabled setting, a usage budget, limited evidence access, and a recorded rationale.

AI suggestions are advisory. They cannot directly claim tasks, assert a verified login/plan/quota, mark output complete, authorize resubmission of uncertain requests, or execute arbitrary repair code. Any automated action must pass the same deterministic ownership, permitted-action, and postcondition checks. The system remains functional if AI assistance is disabled or unavailable.

## 14. Drawbacks and mitigations

| Risk | Required mitigation | Remaining limitation |
|---|---|---|
| More code and manager bugs | Reuse existing services, standardize contracts, stage rollout, test failures | Ongoing maintenance remains necessary |
| Competing authority | One task-claim authority and explicit responsibility boundaries | All participating entry points must adopt the protocol |
| Battery/cloud overhead | Change-driven reporting, batched updates, bounded checks, idle account audits | Active supervision still consumes resources |
| Alert fatigue | Cause grouping, incident lifecycle, severity and actionable notifications | Some incidents require owner judgment |
| Unknown website failures | Preserve evidence, bounded recovery, isolate broken adapters | Interface changes may require a code fix |
| Coordinator outage | Durable records, restart recovery, local checkpoints, pause new unsafe work | Availability is reduced while ownership cannot be verified |
| Incorrect automatic recovery | Small recovery scope, verification, retry budgets, preserve outputs | Ambiguous external requests may require manual reconciliation |
| Misleading account data | Evidence labels, timestamps, scoped limits, preflight checks | Some providers do not expose complete quota information |
| Manager failure going unnoticed | Health/freshness signals surfaced by parent/UI and persisted incidents | Full service outages may only become visible on reconnection |

## 15. Nonfunctional requirements and success measures

The following are proposed release targets, to be measured under a documented test environment rather than represented as existing guarantees.

- **Assignment correctness:** zero simultaneous valid owners for one task in concurrency and failure tests; zero accepted stale-attempt publications.
- **Recovery correctness:** no blind replay of uncertain external generation; verified completed checkpoints survive tested restarts and acknowledgment loss.
- **Status timeliness:** target p95 of five seconds from an accepted connected-source event to Studio display under healthy test-network conditions. This is event-to-display latency, not a requirement for five-second health polling. Health cohorts use the separate cadence below; offline time is excluded and freshness remains explicit.
- **Failure visibility:** every detected automation failure creates or updates an incident and records its recovery outcome.
- **UI-change visibility:** every new confirmed monitored UI change is traceable through the device Image Clipper Manager to an Issues Manager notification; repeated delivery does not create repeated owner alerts.
- **Audit coverage:** every eligible profile receives a completed audit within its configured 24/48-hour interval. Busy/offline deferrals are visible and separately measured.
- **Bounded resource use:** no unconditional high-frequency full-library scans, cloud listings, or account audits. Measure cloud operations, payload volume, and device overhead before rollout; select final budgets from that baseline.
- **Debuggability:** trace a task through assignment, command, account choice, external submission where observable, output verification, transfer, and recovery using correlated identifiers.
- **Privacy:** redact secrets from shared status, screenshots, and logs; define retention and deletion controls before enabling evidence capture.

Track automatic recovery rate by failure class, median blocked time, repeated-request incidents, unnecessary regeneration, stale-status incidents, account-audit coverage, and owner interventions per production run. Establish pilot baselines before committing improvement percentages.

### Cloudflare and agent reporting requirements

The 24 October source implementation satisfies the following local behavior contracts. Production resource targets remain release measurements; see the [implementation evidence](../../MAPI/Sleeper-cell-main/docs/cloudflare-usage-implementation.md).

**COST-01 — Change-driven reports.** Publish meaningful facts, terminal states, incidents, acknowledgments and UI compatibility changes. Sampling-only timestamps must not create new UI events. Coalesce only eligible unsaved ordinary progress before assigning immutable event IDs. Suppress legacy process/crop facts only after accepted native coverage matches device, scope, stage, state, input revision and counts; otherwise retain fallback.

**COST-02 — Honest, batched health.** Cohort actual manager observations per device every five minutes for recently active work and fifteen minutes while idle. Retain each manager's actual source timestamp and sequence; never refresh unobserved managers. Reporter staleness is 45 minutes, separately from fact freshness and task progress. A health-only report must not load or rewrite the full facts/incidents projection. Condition-bearing reports and owner acknowledgments retain their authority path.

**COST-03 — Durable bounded delivery.** Negotiate `manager-batch/1`; envelopes contain at most 16 original events and 256 KB. Preserve identity, ordering, timestamps and exact per-event acknowledgments. A rejection blocks later same-source events in that envelope while independent sources may succeed. Retain single-report fallback. One Android drain owner and a final producer-synchronized recheck prevent lost wakeups; each Studio/Android drain invocation is bounded to eight rounds. Persisted pending events are not discarded to meet a traffic target.

**COST-04 — Backoff and shared pauses.** Desktop failed socket opens follow jittered 2/5/15/30/60-second delays; reset only after that socket is open and stable for 60 seconds. Authentication failures wait for corrected configuration. All relay transports honor persisted budget pauses, including messages on already-open sockets; retain the longest valid deadline and a conservative fallback for unknown 429s. Scope daily-budget pauses by relay URL and explicit connection/device limits by socket role. The authenticated outer-Worker rejection cache may avoid DO calls, but cannot replace the durable limiter or eliminate Worker ingress.

**COST-05 — Independent snapshot delivery.** Timestamp-only library/process updates must not republish unchanged semantic content. Persist original snapshot bytes and separate R2/relay destination acknowledgments across retries and restart. Read back ambiguous R2 writes before retransmitting; a failed relay delivery must not repeat an acknowledged R2 upload. Canonical unchanged receipts avoid writes/broadcasts; explicit command answers remain deliverable. Managed artifact publication checks remain authoritative.

**COST-06 — Deadline-driven checks.** With negotiated capability, reuse returned account due/retry deadlines; pending original audit claims bypass the cache. Owner edits/rechecks and recovery availability invalidate deadlines, with protection against stale in-flight replies. Empty recovery polls back off through 2/5/15 minutes with a bounded fallback. A hint grants no execution authority; leases, preflight, idle ownership and task admission checks remain mandatory.

**COST-07 — Low-cost presence and measurement.** Preserve hibernating sockets and automatic ping/pong. Keep the 60-second liveness alarm; checkpoint unchanged live-presence timestamps no more often than every five minutes while retaining live attachment-based freshness and immediate connection transitions. Aggregate route/signal counters in existing budget checkpoints without a new telemetry request or per-event write. Measure Worker requests, DO calls/messages/alarms, SQL rows, duration and R2 operations separately.

**COST-08 — Compatible measured rollout.** Deploy relay capabilities, restart updated Studio, then release Android through GitHub Actions and validate both phones/Master. Preserve reporting journal schema 3 on rollback with a compatible release. Observe a complete UTC day, queue drainage, critical alerts, owner rechecks and sleep/wake behavior before declaring savings. The original ≥95% rejected-traffic reduction is a target, not an achieved result. Full paginated replay remains supported; add a resumable cursor only if measured replay cost warrants it. Do not reduce durable budget checkpoint guarantees or ownership renewals as part of status optimization.

## 16. Acceptance scenarios

| ID | Scenario | Required result |
|---|---|---|
| A01 | Two phones claim the same eligible task concurrently | Exactly one current assignment is granted. |
| A02 | Two Studio sessions start overlapping work | Shared ownership and resource checks prevent conflicting starts. |
| A03 | Phone 1 disconnects before a command is confirmed accepted | Task becomes uncertain unless unsent status is established; no blind replay. |
| A04 | Phone 1 disconnects after submitting an AI request | Phone 2 continues other work; the uncertain request is not automatically repeated. |
| A05 | A safely released task moves to Phone 2; Phone 1 returns | Phone 1 reconciles and cannot resume its obsolete assignment. |
| A06 | Old attempt uploads after reassignment | Its output cannot overwrite the current canonical result. |
| A07 | Phone saves a valid result, then crashes before reporting | Reconciliation discovers and reuses the result. |
| A08 | Mac or relay restarts during active work | Durable ownership and command state survive; no automatic restart from chapter one. |
| A09 | Owner pauses/cancels while a recovery is pending | Automatic recovery does not restart the paused/cancelled work. |
| A10 | Current script/page revision changes | Only affected dependent work becomes outdated; older completion cannot satisfy it. |
| A11 | Generation quota exhausts with an allowed eligible fallback | Task checkpoints/context are preserved; alternative capacity is reserved before continuation. |
| A12 | Two profiles share an exhausted account quota | Both reflect the affected shared quota; switching profile does not manufacture capacity. |
| A13 | Upload allowance exhausts or upload times out | The system distinguishes the cause and reconciles attachment state before retrying. |
| A14 | Account signs out | Profile becomes unavailable, one actionable incident appears, and independent work continues. |
| A15 | Account audit times out | State becomes unknown/check failed; it is not falsely labeled logged out or free. |
| A16 | A quota reset estimate passes | Capacity is rechecked before being treated as available. |
| A17 | Expected button is missing | Known recovery attempts are bounded, page/postconditions verified, and unresolved ambiguity reported. |
| A18 | An earlier click succeeded but its acknowledgment was lost | Recovery inspects resulting state and does not blindly repeat the click/submission. |
| A19 | A daily audit becomes due while the profile is busy | Audit is deferred visibly and never steals the active session. |
| A20 | One underlying failure affects several devices/stages | One grouped incident retains all impacts and recovery attempts. |
| A21 | Cloud upload succeeds but Mac import fails | Generation remains complete; only the missing import is retried. |
| A22 | A stale receipt arrives after a current one | Current evidence remains authoritative and its freshness is not fabricated. |
| A23 | A legacy phone or manual start bypasses task ownership | Managed concurrent dispatch is blocked or that execution path is integrated before use. |
| A24 | Optional AI diagnosis is disabled or unavailable | Core monitoring, scheduling, account checks, and known recovery still operate. |
| A25 | No allowed website/profile meets a task's requirements | Task waits with a precise blocker; no silent provider/model downgrade occurs. |
| A26 | Required content review is pending | Automation stops at the existing review gate despite otherwise valid technical outputs. |
| A27 | A supported control/layout changes on ChatGPT, Gemini, or Google AI Studio | For each website, evidence travels from its device UI Monitor to the Device Image Clipper Manager, then the Issues Manager, and produces an owner notification. |
| A28 | A confirmed cosmetic change does not break clipping | The same reporting chain delivers one informational notification; healthy work continues. |
| A29 | Conversation content streams, a known overlay appears, or the page is still loading | Expected transient/content changes are not falsely reported as a confirmed website redesign; unresolved compatibility is labeled uncertain. |
| A30 | A UI change appears on only one device/profile variant | Impact and baseline remain scoped to that variant; other devices are not automatically marked incompatible. |
| A31 | A UI-change report is queued offline and replayed twice | Both manager handoffs persist and complete on reconnect; the owner receives one notification for the change. |
| A32 | A required control changes during active automation or an idle audit becomes due | Monitoring does not hijack the session or repeat a submission; affected work follows existing recovery rules, and acknowledgment alone does not erase the old baseline or unblock work. |
| A33 | Managers are idle, then work becomes active | Health uses 15/5-minute cohorts with original per-manager times; facts and progress remain separate; empty health bypasses the full projection. |
| A34 | Repeated UI samples and overlapping native/legacy reports arrive | Sampling-only changes create no new cloud event; meaningful changes still publish; legacy suppression requires matching accepted native evidence and retains fallback otherwise. |
| A35 | A batch is duplicated, partially rejected or interrupted by restart | Immutable IDs/sequences survive; exact per-event acknowledgments remove only accepted events; later same-source events stop; independent sources and legacy fallback work within count/byte/drain bounds. |
| A36 | Socket upgrades fail or the relay rejects traffic | Stable-open backoff, authentication cutoff and persisted scoped pauses suppress retries across HTTP/socket paths and restart; cold Worker isolates still consult the durable limiter. |
| A37 | R2 succeeds but relay fails; unchanged snapshots/receipts recur | Destination acknowledgments survive restart, successful uploads are not repeated, ambiguous writes are read back, timestamp-only snapshots are suppressed and explicit command answers still arrive. |
| A38 | Account/recovery poll is empty, then an owner requests recheck | Deadlines/backoff avoid repeated empty calls; hints invalidate promptly, stale replies cannot restore an obsolete deadline, and pending claims plus original authorization remain intact. |
| A39 | An idle socket pings and the relay reaches its daily cap | Runtime ping does not add application operations/writes; presence remains accurate, checkpoints are bounded, and rejected retries/restart do not churn budget writes. |
| A40 | Compatible relay, Studio and both phones/Master are released | A full UTC-day comparison records each resource separately; queues, critical alerts, command admission, rechecks, sleep/wake and compatible rollback pass before savings are accepted. |

## 17. Delivery phases and release gates

### Phase 1 — Trustworthy status and incidents

Standardize evidence, revisions, freshness, module ownership, and issue reporting around current services. Add passive account inventory and observation, plus the Website UI Monitor Agent and its device Image Clipper Manager → Issues Manager → owner reporting path. Managers report mismatches before taking new automatic recovery actions.

**Gate:** module views agree on current evidence; stale/offline facts remain identifiable; grouped incidents accurately explain blockers. A27–A31 pass for UI-change detection, reporting, variant scope, and replay.

### Phase 2 — Durable automation ownership

Introduce task identity, atomic assignment, command acknowledgment, reservations, checkpoint reconciliation, stale-attempt protection, and coordinated manual entry points. Migrate compatible phones together; exclude legacy clients from managed concurrent runs.

**Gate:** A01–A10, A18, A22, and A23 pass across disconnect, restart, duplicate-message, and concurrent-start tests. No automatic uncertain-request replay.

### Phase 3 — Accounts and bounded recovery

Enable scheduled account/UI audits, provider/profile policy, quota waits, eligible fallback, transfer recovery, known UI recovery, and automatic resume after verified repair. Connect reported website compatibility changes to bounded recovery without giving the UI Monitor dispatch authority.

**Gate:** account/recovery scenarios and A32 pass; retry budgets and owner pause behavior hold; independent work continues during isolated failures. Run an observed multi-device pilot before unattended use.

### Cross-phase resource release gate

COST-01–COST-08 and A33–A40 apply across all delivery phases. Source/local validation is recorded separately from installed acceptance and a complete UTC-day usage comparison. This gate supplements the ownership/recovery gates; it does not complete them.

### Phase 4 — Optional diagnostic assistance

Evaluate AI-assisted incident explanation and unfamiliar-page diagnosis only after deterministic behavior is stable. Enable separately with budgets and evidence controls.

**Gate:** assistance improves diagnosis without acquiring authority over ownership, completion, or unsafe retries; disabling it has no effect on core correctness.

## 18. Decisions for implementation planning

These do not block review of the product requirements, but must be resolved before the relevant implementation phase:

1. Exact location and persistence model for the authoritative task/account/incident records; Cloudflare relay storage is the proposed default.
2. Ownership renewal intervals, progress deadlines, and recovery delays validated against real Android/background behavior and task durations.
3. Provider-specific capability, account identity, usage, and reset evidence available from supported website adapters.
4. Checkpoint/context portability per workflow and conditions under which profile/provider fallback is actually resumable.
5. Initial preferred/fallback policies and whether individual stages may use estimated capacity after a successful readiness check.
6. Evidence retention periods and screenshot capture defaults.
7. Scope of phone-only continuation while the Mac is offline and which existing prerequisites still require the Mac.
8. Optional AI diagnosis provider and budget, only if that later capability is selected.
9. Initial supported UI states and validated baselines for each website/device variant, visual-difference thresholds, and the process for accepting baseline changes without hiding unresolved incompatibility.

## 19. Reference points

Existing repository foundations; these are integration references, not proof that proposed functionality is implemented:

- [Product and workflow overview](../README.md)
- [Production stage model](../server/src/services/seriesProcessModel.ts)
- [Production state aggregation](../server/src/services/seriesProcess.ts)
- [Automation configuration and chapter allocation](../server/src/services/productionAutomationModel.ts)
- [Production runner](../server/src/services/productionRunner.ts)
- [Automation execution](../server/src/services/productionAutomation.ts)
- [Profile commands](../server/src/services/phoneProfiles.ts)
- [Phone readiness](../server/src/services/phoneReadiness.ts)
- [Phone receipts](../server/src/services/phoneReceipts.ts)
- [Shared library synchronization](../server/src/services/librarySync.ts)
- [Relay behavior](../relay/README.md)
- [Staged Editor checkpoints](editor-timeline-stages.md)

Background sources reviewed during ideation:

- [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): transactional, strongly consistent coordination storage.
- [AWS: leader election and leases](https://aws.amazon.com/builders-library/leader-election-in-distributed-systems/): stale ownership, partial failure, and externally visible work.
- [AWS: safe retries](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): repeated requests and ambiguous outcomes.

