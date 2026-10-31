# Phase 3 — Durable task authority and one-device pilot

20 October 2026. **In progress: explicit single-page installed-phone execution/publication passed on Nord Free, Go and Plus profiles. Go/Plus completed-task restarts and original saved-result recovery after process exit and lease expiry passed.** Full ProductionRunner integration, downstream managed review/cut/Editor completion, revised-input rebinding and remaining uncertainty/cancellation acceptance still gate full Phase 3. Historical implementation milestones below retain their original scope; current live evidence is in [validation](validation.md).

## Implemented foundation

`relay/src/taskAuthority.ts` provides real SQLite tables and transaction-scoped operations for crop-page tasks, attempts, commands, reservations, immutable artifact references, enrollment and idempotent event results. The relay entry point now exposes it through the metered SQL boundary only when the explicit managed feature flag and separate credentials are configured. Production has not been deployed or enabled for this milestone.

- Stable task identity uses the Phase 0 tuple `(workspace,series,chapter,crop_json,null,page,pageId,inputFingerprint)`. Fingerprints hash canonical ordered dependency/revision/content evidence and explicit provider/product/model/settings/prompt/validator versions. Run identity does not create duplicate work.
- Claim writes an attempt generation, start command, and device/browser/profile reservations atomically. Conflicts roll back all writes. Compatible capability references and explicit profile enrollment are prerequisites, and the API obtains capabilities from a fresh authenticated handshake rather than an arbitrary enrollment body.
- Worker checkpoint/renewal methods require a transport-supplied phone principal. Task/attempt/generation/input fingerprint and the exact current command ID fence acknowledgments. An actor supplied by a request body is not authentication.
- Submission intent becomes `unknown` before an external action; another intent cannot silently replay it. Saved results require opaque checkpoint references. Lease expiration prevents further actions and retains uncertainty/reservations; it does not grant a replacement owner.
- Owner pause/cancel records durable stop intent. A local stop with unresolved provider submission retains capacity uncertainty. No automatic recovery or profile/provider switching is implemented.
- Artifacts must have immutable attempt-scoped references and content hashes. Conditional canonical reference publication compares current generation/fingerprint/owner/state and requires a separate trusted Studio destination-validation receipt. The authenticated artifact API now verifies immutable R2 bytes before staging/publication. The separate Studio adapter verifies a private local destination and real source-image evidence before supplying that receipt; production consumer integration remains pending.
- A Studio-authenticated read-only task/attempt/command query is available for the future timeline UI. Command history is indexed by task. The initial planner refuses more than 1,000 stored pilot tasks rather than doing an unbounded scan or silently truncating history.

## Authenticated transport and Android journal

`server/src/services/managedTaskProtocol.ts` defines the shared strict `managed-task/1` contract. `relay/src/managedTaskApi.ts` provides separate Studio and device credentials, a device-bound inbox, handshake, explicit Studio enrollment, task operations and task history. Request bodies cannot supply principals. The observation token cannot authorize managed operations; duplicate/shared or malformed credential configuration fails closed. Enrollment requires a matching profile and authenticated capability evidence no older than 15 minutes. Replaying a handshake does not renew its timestamp.

Android source now includes `ManagedJournalModel.kt`, `ManagedCommandJournal.kt` and `ManagedRelayClient.kt`. The app-private SQLite journal atomically records commands, a local guard, immutable outgoing receipts and saved checkpoint bytes/hashes. It preserves unknown submission outcomes and quarantines rejected events. Restart requires reconciliation before website work can continue. Acknowledgments must match task, attempt, generation, fingerprint, command and device. Late results can be retained locally without publishing completion.

The client is opt-in, has no polling job, and performs no website actions. It advertises only `managed-transport/1` and `command-journal/1`; **this is intentionally insufficient for managed executor enrollment**. The journal guard now covers the four browser autorun entry points, including their manual, scheduled and remote callers, plus remote profile operations. No UI credential-pairing flow or production configuration was added.

Configuration for a future isolated pilot:

- Relay: `MANAGED_CROP_PAGE=1`, `MANAGED_WORKSPACE_ID`, a separate `MANAGED_STUDIO_TOKEN`, and secret `MANAGED_DEVICE_TOKENS` JSON mapping registered device IDs to distinct tokens. Store credentials as secrets, never in source or URLs. Missing configuration leaves the feature disabled. Do not reuse `RELAY_TOKEN` or share Studio/device keys.
- Android: private `managed-relay` preferences contain `enabled` (default false), `workspace` and `device_token`. The endpoint must use HTTPS except for loopback/emulator testing. Credential pairing remains future integration work.
- Managed operations use the existing durable daily budget and measured SQL accounting. This adds no background polling or production traffic. Account-wide Cloudflare ingress still requires separate measurement; local budgets do not guarantee the account-wide Worker allowance.

## Legacy dispatch admission

`relay/src/managedLegacyFence.ts` rejects legacy run start/stop/finish and profile controls for any durably enrolled device. It checks existing SQLite enrollment independently of the managed feature flag. Broadcast browser controls fail as a whole if any device is enrolled; specifically addressed unenrolled phones continue to work. Receipt refresh/sync and screen observation remain available. Cached legacy starts saved before enrollment are filtered when the phone reconnects. Both HTTP and WebSocket ingress enforce this boundary, with HTTP 409 or a correlated `request:rejected` reply before storage/forwarding.

Studio's shared `sendPhoneRequest` path now sends these browser controls over HTTP and waits for admission. ProductionRunner, manual Studio controls and profile commands inherit that response; a socket send no longer reports success for a rejected browser command. This is admission protection, not managed task planning or execution in ProductionRunner.

On Android, `LegacyRunAdmission` and `ManagedLocalOwnership` register local browser work with the journal before executor initialization. Manual, scheduled and remote calls to ClipperRun, narration AutoRun, EditorRun and VoiceoverRun use this gate. Remote profile selection/options use the same exclusion. Managed acceptance/pairing and legacy admission share a monitor, closing the check/start race. A local owner remains registered until the coroutine and its cleanup finish, including after cancellation. Existing legacy concurrency is unchanged when no managed exclusion applies.

An enabled managed configuration or active/uncertain journal guard blocks legacy starts. Before the first authenticated hello, pairing also commits a `legacy_blocked` preference; disabling transport later does not remove that exclusion. Managed acceptance/pairing refuses while registered local jobs remain active. Pending remote jobs are checked again when MainActivity starts them, before resuming or changing run scope. Clearing data or manually editing preferences is not a supported rollback. An explicit reconciled unenrollment flow remains future work. Browser actions performed directly by the user outside these run entry points remain an external activity limitation.

No production enrollment, dispatch or deployment was performed. These guards require the future GitHub Actions APK; they are not present in the previously checked 1.0.130 build. No polling is added. Each Studio browser-control action now incurs one Worker HTTP request instead of using its existing socket; refreshes retain the socket path, and all relay SQL stays within the daily budget boundary.

## Immutable artifact storage and Studio validation

`managed-crop-page/1` bundles the exact pointer and metadata JSON text, checkpoint reference and task/attempt/generation/fingerprint/revision. `server/src/services/managedCropArtifact.ts` validates the explicit `managed-crop-validator/1` version, UTF-8, dimensions, normalized convex four-point geometry, crop ID correspondence and safe metadata filenames. It accepts explicit empty crop/metadata arrays; an acknowledgment alone cannot create a result. No output is repaired or substituted on validation failure.

`POST /managed/artifacts` requires a phone credential, strict stage operation and actual document bytes. The API verifies the saved checkpoint, owner and hash, durably reserves one immutable upload slot per task, conditionally creates its attempt-scoped object, reads it back and then records staging. Hash-only `stage` operations on `/managed/operation` are rejected. Studio-authenticated `GET /managed/artifacts/<artifactId>` returns verified bytes and fenced metadata. Publication re-reads and validates the object, then checks cancellation, ownership and lease again in the synchronous SQLite commit. Late bytes can remain staged for reconciliation but cannot become canonical for cancelled/expired work.

The optional `MANAGED_ARTIFACTS` R2 binding is **not configured in production**. Missing storage returns 503 for upload/publication. The local-only [Wrangler test configuration](../../relay/wrangler.managed-test.jsonc) supplies an emulated bucket; do not deploy that test configuration. Slots are allocated before asynchronous object writes and persist across restart: at most **256 slots and 64,000,000 bytes**, at most 1,000,000 bytes per document, one upload identity/hash per task. Failed or abandoned slots remain charged, and retries cannot silently allocate new objects. These are relay-local bounds, not a guarantee of unused account-wide R2 storage or operation allowance. Daily SQL/operation budgets still apply; no polling or automatic upload retry was added.

`server/src/services/managedArtifactImport.ts` provides an explicit transport and immutable private destination. `resolveManagedCropInput` reads the actual source image, checks its hash against the planned page dependency and obtains real dimensions. The importer checks current shared input identity before and after local staging and after acknowledgment. It validates the image identity/dimensions, writes an exclusive temporary file, flushes it, links an immutable destination, verifies readback and flushes the directory. A deterministic validation receipt and publication event survive a lost acknowledgment. Existing conflicting bytes and symlink destinations are rejected. The relay remains the sole owner/canonical-reference authority.

The caller must supply the production identity/spec/source resolver. ProductionRunner dispatch and downstream managed cut routing are still pending. Existing crop readers now consume the verified local projection described below; legacy imports and mutations are blocked for bound scopes. The artifact adapter continues to write only a separate managed namespace, without copying generated JSON into canonical legacy filenames.

Android now has a pure `ManagedArtifactModel` and explicit `uploadSaved` transport method. It derives a stable packet from acknowledged saved checkpoint bytes shaped as `{pointers: string, metadata: string}`; the structured output and checkpoint remain in the SQLite journal. Packet/document hashes, upload IDs and stage event IDs survive restart; UTF-8 errors, unknown/cancelled/blocked or unacknowledged results are rejected. There is no automatic job, website execution, legacy chapter ZIP upload or new full execution capability advertisement. The real executor still needs to produce this checkpoint format and call the upload path. No APK was built or installed.

## Current crop read projection and legacy import fences

`server/src/services/managedCropProjection.ts` records a durable per-page binding under the chapter's `.managed-crops/` directory. The future planner must call `bindManagedCrop` with its authenticated plan response and the private destination root **before dispatch**. Binding checks the shared task identity/specification and actual source bytes. It does not claim a task, assign an owner, enroll a device, or grant a lease. New input bindings require the expected previous task ID; old publications remain historical. An explicit reconciled detach/unbind flow is not implemented.

After verifying a publication acknowledgment, the destination now atomically records a flushed immutable `publication.json` projection for that task. It retains only immutable attempt/checkpoint fields, so replay after lease/status changes does not invent new receipt content. Readers validate the task identity, canonical reference, bundle checksum and exact destination validation receipt, then compare actual source image evidence. The relay remains the sole task owner and canonical-reference authority; its verified-complete task references are immutable. These receipts are trusted private Studio projections, not cryptographic attestations against a compromised local filesystem.

`readImagePoints`, `readImageMetadata` and their stem listings now use that projection for bound pages. Missing publication, changed source bytes or an unmatched image filename returns pending. Corrupt bindings/receipts/artifacts fail closed. **There is no fallback to an old `crop_points3`/`crop_metadata3` file for a bound page.** Chapter-state reads share one local read snapshot. Crop readers perform no Worker, Durable Object or R2 requests. Publication/binding events invalidate the process cache even when private artifacts live outside the download watcher.

The shared write/delete helpers reject legacy edits of bound pages. Legacy Sync/Unsync, phone ZIP imports and cropped-marker publication, clipping reset, page-bin/stitch mutations and chapter cutting share conservative binding fences. Binding and supported legacy mutations use local locks; cleanup/deletion also serializes with registration and preflights protected ancestors/descendants before changing files. Working-file cleanup previews exclude protected scopes and deletion rejects them. Transport/feature disablement does not remove the durable binding. Never delete the binding manually to bypass the guard.

The process projection discovers managed-only chapters and preserves local managed crop evidence when merging legacy phone progress. Existing PNGs cannot mark a managed cut complete just because names match. Managed chapter cutting remains blocked, and its output counter stays incomplete until revision-bound cut publication exists. This includes mixed chapters; no partial legacy cleanup is allowed to erase managed outputs. Direct external filesystem changes are detected at read time rather than represented as coordinated actions.

**Rollout boundary:** no production page was bound, no new public planning endpoint was added and no automatic dispatch was enabled. ProductionRunner/planner registration, the real Android executor, managed cut routing/completion, review/timeline integration and installed-phone acceptance still block the Phase 3 exit gate. Other direct consumers that scan legacy crop folders (for example Editor 2.0 timeline resolution) must be integrated before managed outputs can proceed downstream.

## Revision-bound local cut derivatives

`server/src/services/managedCropCut.ts` adds explicit `cutManagedCrop` and `readManagedCropCut` adapters. They require the exact current page binding and verified crop publication, revalidate the actual source hash/dimensions, and render from the exact hashed source buffer. This follows the existing cutter's axis-aligned bounding rectangle interpretation for perspective points; it does not introduce a perspective warp. Pixel rounding that produces an empty rectangle fails rather than inventing a crop.

Each result is stored under the private destination's task directory in `cuts-v1/`, with an immutable `managed-crop-cut/1` receipt bound to task fingerprint, source hash and published crop artifact/hash. The receipt lists each crop ID, metadata filename, output checksum, byte count and dimensions. All PNGs and the receipt are exclusively created/flushed in a temporary sibling directory. After complete readback and a fresh source/binding/publication check, a same-volume rename publishes the set and the parent directory is flushed. Supported binding/cleanup changes serialize with rendering. If an external source change races the rename, post-commit verification rejects completion; the bytes remain historical. External filesystem mutation is not claimed to be coordinated.

Existing results are verified and reused without rewriting. Missing, altered, additional or symlinked published output fails closed; it is not regenerated over. Reads recheck the current binding/source and verify the files/receipt without network requests. Empty crop results create a receipt and no PNGs. Rendering is bounded to 64 MB source, 64 MB total encoded PNG output and 100 million aggregate output pixels per task; source decoding also uses Sharp's 100 million pixel bound. Interrupted temporary directories are not automatically adopted or deleted on later startup; an explicit reconciliation/cleanup policy remains pending.

This adapter is a **local derivative**, not a new relay task, cloud artifact or chapter-completion publication. It adds no Cloudflare traffic. Legacy `crops3/`, chapter cleanup, auto-crop and existing cut counters remain fenced for bound chapters. Routing verified derivatives into chapter/review/Editor 2.0 consumers, including mixed chapters and a bound cut-completion projection, remains the next integration step. No production endpoint or automatic invocation was enabled.

## Verification

The full server suite passed **51 files / 408 tests**; Android offline JVM passed **307 tests with zero failures/errors/skips**. Server build and relay TypeScript passed. Android source was unchanged for the crop-reader and local-cut milestones; 307 JVM tests remain the prior artifact-uploader result. The managed coverage includes 12 real-SQLite authority tests, 11 authenticated API tests, three Kotlin interoperability tests and nine Android journal model tests. Four legacy-fence tests, a Studio HTTP-rejection regression and three Android local ownership tests cover this milestone; the race test repeats pairing/start contention 100 times. Sixteen artifact/destination tests, an actual Kotlin artifact interoperability check and four Android artifact-model tests cover the new storage adapters. Twelve additional projection/integration tests cover the existing readers, pending/stale/corrupt evidence, write/import/cut/cleanup fences, compare-and-swap binding and lost-acknowledgment recovery. Two process-cache/remote-progress tests and a recursive storage deletion test cover the downstream safeguards. Eight local-cut tests use real Sharp PNG rendering and filesystem writes: exact geometry/receipt validation and reuse, changed inputs, corruption/missing/extra files, symlink directories, concurrent cuts, source changes at commit, explicit empty output and input rebinding. Other repository regression tests are included in those totals.

An actual Kotlin-emitted checkpoint operation parses in TypeScript, using the shared task fixture with Unicode model text and identical canonical hashes. The fixture generator and snapshots are in [phase3/](phase3/). Android JVM tests validate the pure model; they do not instrument SQLite crashes or app process death.

`relay/scripts/managed-task-check.mjs` passed against an isolated local Wrangler Durable Object: authenticated handshakes/enrollment, concurrent claims with exactly one owner, device-bound inbox, forged-worker rejection, and duplicate acknowledgment. After stopping and restarting Wrangler against the same persisted SQL store, replay retained the task, owner, command and acceptance without a second attempt. Synthetic clients advertise full capabilities for this test only; this does not establish Android executor readiness. Node SQLite re-instantiation tests remain separate from this actual relay process restart. An independent unconfigured local relay returned 503 for managed operations, confirming the default-off entry-point gate. No synthetic operation reached production.

`relay/scripts/managed-legacy-check.mjs` also passed against a real isolated Durable Object: all nine legacy browser controls rejected for enrolled/broadcast targets, specifically addressed unenrolled devices worked, HTTP and socket rejection agreed, a pre-enrollment queued start was withheld on reconnect, and sync remained available. After a process restart with the managed flag and credentials absent, managed operations returned 503 while enrollment still fenced legacy controls. See [recorded milestone evidence](phase3-legacy-validation.json).

`relay/scripts/managed-artifact-check.mts` passed with an actual local Wrangler Durable Object, local R2 emulation and real Studio filesystem writes: concurrent identical uploads, readback/hash checks, actual source-image validation, a flushed immutable destination and canonical publication. After stopping/restarting Wrangler against the same storage, object bytes, SQL completion and the deterministic destination receipt replayed successfully. This used a synthetic explicit empty-crop result, not an installed-phone workflow or production R2. A new process restored that publication and fed it through the existing crop readers; legacy edits were rejected. See [consumer evidence](phase3-consumer-validation.json). [Recorded evidence](phase3-artifact-validation.json).

These checks exercise parts of A01/A02/A06–A10/A23, not their complete integrated acceptance scenarios. No APK was built or installed for this milestone. Production remains at relay version `2b02e41b-d1ee-4d9c-b7a9-6c191168ebac`.

## APK prerequisite carried into this phase

The user requested that the previous phase's APK changes be verified during Phase 3. The earlier Nord preflight recorded **1.0.129 / 1000129**. Read-only preflight verifies its existing release certificate and Website UI probe; the probe matches the current shared source. Its DEX files **lack** the `manager-relay-budget` / `pause_until` quota-backoff markers. That Nord build did **not** satisfy the new APK prerequisite. A subsequent read-only check on the USB-connected **Note 10 Pro / 3466057e** found **1.0.130 / 1000130**, matching the release signature and current probe, and containing both quota-backoff markers. After the user enabled Manager observations, 225 native phone facts were authority-accepted and a receipt refresh correlated specifically to the Note. See `phase3-apk-preflight-note10.json` and `phase3-apk-live-validation-note10.json`. A 330-second live check correlated all six receipt refreshes (scripts/crops/sync), retained 225 authority-accepted native account facts and zero pending/error state. No additional native batches were produced. The exact five-minute device/sync health interval is **inconclusive** because this refresh path did not capture new process evidence; the setting throttles health emission rather than scheduling a periodic capture. Forced Retry-After/restart behavior also remains unverified on the installed phone. See `phase3-apk-cadence-note10.json`. No local APK was built or installed.

Repeat after the user installs a GitHub Actions release:

```sh
python3 docs/manager-agents/protocol/apk-preflight.py \
  --device 54a03a76 --require-budget \
  --output docs/manager-agents/phase3-apk-preflight.json
```

Exit 2 means signing or the requested packaged code prerequisite failed. This packaging check is necessary but does not prove runtime behavior. The release gate also requires:

1. Confirm five-minute health-only reporting while changed facts remain prompt and source timestamps are preserved.
2. Check `429 / Retry-After` and queue retention/restart against an isolated test relay with a compatible APK; do not exhaust production quota to simulate failure.
3. Confirm no repeated HTTP deliveries during the persisted pause and correct delivery after reset/backoff.
4. Recheck Phase 2 baseline/control receipts and one complete UTC day of account-wide usage against all four free allowances. Relay-local partial-day counters cannot certify account-wide totals.

## Remaining Phase 3 work

1. Validate the newly wired explicit single-page executor/pairing on a GitHub Actions APK. Its source persists upload/submit intent, checks authority, and holds unknown outcomes. Installed-phone crash/WebView/cancellation acceptance remains open.
2. Integrate managed task planning/dispatch into the full-series ProductionRunner. Explicit single-page Studio controls and phone pairing/reconciled unenrollment are now wired separately and correlate started/saved/stopped receipts. Legacy relay controls and the four Android autorun entry points are now fenced; validate the installed-phone boundaries before enrollment.
3. Validate the newly connected executor/checkpoint/uploader and bind-before-claim flow on the selected real page. Crop JSON readers and legacy mutation/import guards are connected; route the immutable local cutter into revision-bound chapter completion, implement explicit reconciliation/unbinding, review and downstream timeline consumers before enabling rollout.
4. Extend the new explicit task/command status view into the full production timeline.
5. Verify cancellation/restart/unknown outcomes at real executor boundaries, with a GitHub Actions APK and an owner-selected test page. Keep automatic failover disabled.

The owner has selected Nord/Saran (free plan), ChatGPT’s available default model without model selection, Rogue First Prince chapter 1/page 1. Refresh page/profile/default-model evidence before claiming; executor/pairing/planner implementation still gates enrollment. No production task was created. Existing legacy runs and the deployed free-tier protections continue independently.


## Nord wireless rollout follow-up

User-installed Nord 1.0.132 passed signing/probe/backoff packaging and live native receipt/reconnect checks on 19 October. Verification exposed a production single-row projection-size failure; the tested chunked-projection fix was deployed as `c3c2651e-c129-4775-a54a-5eb9e592e7f6`, preserving configuration. The older version IDs above record earlier milestones. Reports now drain with zero active runs; production managed execution remains disabled. Retain the chunk-aware projection decoder on rollback. Exact Phase 3 runtime support is not inferred from release packaging, especially where unused paths were removed by shrinking. See [wireless validation](validation.md#nord-wireless-validation-and-reporting-size-repair).


## Isolated managed recovery and persistent rate limits

The recovery harness `relay/scripts/managed-recovery-check.mts` uses synthetic worker credentials with real local Durable Object SQL/emulated R2 and real Studio filesystem/Sharp adapters. Start a fresh isolated store with the fixture workspace/token bindings in the script and run `prepare`; stop/restart Wrangler using the same `--persist-to` directory; run `resume`; stop/restart again; run `verify`. Set `MANAGED_TEST_URL=http://127.0.0.1:8799` and a fresh absolute `MANAGED_RECOVERY_ROOT` under `/tmp`. Run the `.mts` script using the server's tsx loader. The first restart must finish before the five-minute lease expires; an expired lease must fail, never be bypassed. Do not deploy the local test configuration.

Passed: binding before dispatch, saved checkpoint bytes/ref across process restart, exact lost-ack checkpoint/upload replay, immutable upload reuse, lost publication acknowledgment retry, verified local cut readback, cancellation fencing and unknown submission reservation persistence through a second restart. This is a simulated executor, not installed-phone acceptance. [Evidence](phase3-managed-recovery-validation.json).

Studio's production report sender now uses `RelayDeliveryPause` for durable HTTP-date/numeric Retry-After handling, including delays longer than a day. Concurrent responses cannot shorten the longest pause; corrupt stored state and failed writes block delivery. Android `RelayRetryPolicy`/`RelayBudgetPause` apply the same policy to reporting and managed transport. No background managed polling was added. Real HTTP/disk restart tests resume the same event after an injected deadline, and actual isolated relay cutoff/restart tests retain the three-operation cap without repeated rejection writes. Android JVM tests reconstruct the pure policy against a temporary file; real APK preference/worker crash instrumentation remains pending. [Evidence](phase3-rate-limit-recovery-validation.json).

Current validation: **53 server files / 413 tests**, server build and relay typecheck; **311 Android offline JVM tests**, zero failures/errors/skips. No APK packaging/install or new production deployment occurred.

Owner-selected pilot: **I Became The Rogue First Prince, chapter 1, page 1**, Nord/Saran **free plan**, using ChatGPT’s available default model **without model selection**. Historical paid-plan/Work options are not current execution policy. [Selection](phase3-nord-pilot-selection.json) records the exact local source hash and unresolved readiness checks. No production task/binding/enrollment was created. Implement the actual Android executor and pairing, Studio plan/bind/claim integration and downstream completion routing before releasing a compatible GitHub Actions APK for that pilot. The current release and another build of the present partial transport are insufficient; do not advertise full capabilities or bypass enrollment.

## Explicit single-page executor and Studio controls

19 October 2026. The single-page default-model pilot is now wired in source. Android `ManagedCropRun` has a real MainActivity host, a dedicated profile-bound ChatGPT tab, an attachment handoff fenced to that exact WebView, and a Settings → Cloudflare R2 → **Managed page pilot** entry. The non-exported pairing screen uses separate private device credentials and a one-time private launch nonce; arbitrary incoming browser intents cannot start the executor. Pairing blocks legacy entry points before hello. Pairing network exchanges use a separate lock so they do not hold the journal/admission monitor while waiting on HTTP.

The executor supports only `chatgpt-default-crop/1` with prompt `managed-chatgpt-default-crop/1`. `model: provider-default` denotes the owner-approved selection policy, **not an assertion about ChatGPT's underlying model identity**. Mode and effort are null; no model/mode/effort controls or provider/account fallback are used. The exact shared series/chapter/filename identity locates one synced page and its immutable hash is checked before upload and submission. The original source is copied into a task-private attachment cache without changing its bytes. The one-turn prompt asks for the structured crop/metadata bundle; invalid output is retained for inspection, not repaired through another provider request.

New commands are committed to the local journal and their accepted receipt is delivered before action authorization. Each mutating UI action requires a fresh fenced authority renewal. The upload and submit actions are individually consumed in a SQLite transaction **before** their side effects; an uncertain action cannot be consumed again. The generation wait renews/checks ownership every 20 seconds within the explicit run, with a twelve-minute overall bound. There is no idle managed polling job. Owner touch or local Stop All stops the local executor without inventing an external-stop acknowledgment. A received authority stop is acknowledged only after the executor has unwound; unknown/submitted outcomes retain reservations.

The raw answer is retained before structural parsing. A valid structured checkpoint and its outgoing receipt commit before upload. Confirmed-unsent preparation can restart; saved output can be uploaded again without provider work while ownership remains valid. Interrupted upload/submission outcomes remain held. The phone queries its authenticated worker view to reconcile a published result and releases its local guard only when task/attempt/generation/fingerprint/checkpoint/canonical-reference checks match. Pairing exclusion remains until explicit unpairing.

Studio now exposes **Phone Status → Managed page pilot** (`/sleeper-cells/managed`), backed by `/api/managed-pilot`. It selects one real page and existing phone/profile, enrolls from a fresh authenticated handshake, plans the stable task, persists the page binding **before claim**, and reuses the existing matching attempt after a lost acknowledgment. Manual status, cancellation, verified import/publication and unpair controls are provided. Dispatch first requires an authenticated relay readiness response confirming the matching workspace, workflow capability and artifact storage binding; it refuses to claim work when storage is unconfigured. The existing immutable importer rechecks the actual current source before publication. This explicit pilot is separate from the full-series ProductionRunner; that runner has not been silently switched to managed dispatch.

The relay adds authenticated worker-only current-task/enrollment reads and a Studio-only `unenroll` operation. Unenrollment refuses active/uncertain reservations and unfinished attempts, then removes both enrollment and peer evidence transactionally. Re-enrollment needs a new phone hello, which first re-establishes the local exclusion. The phone verifies no enrollment, peer or reservation remains before clearing its private pairing preferences. A paused/cancelled unknown outcome cannot be bypassed through Unpair. Studio reporting and explicit managed transports now share the same durable Retry-After gate in the process.

### Validation and remaining gate

**55 server files / 423 tests; 318 Android offline JVM tests, zero failures/errors/skips.** Server/client production builds and relay typecheck passed. Chrome visual review confirmed the new screen renders with dispatch disabled in the current configuration. Seven new real-SQLite/filesystem pilot tests cover bind-before-claim, lost claim acknowledgment, default-only policy enforcement (including bypassing the Studio helper), source changes, lost publication acknowledgment, uncertainty retention, worker read isolation and peer revocation.

The [local harness](../../relay/scripts/managed-pilot-check.mts) uses real local Durable Object SQL/emulated R2 and the actual Studio pilot service. Its assignment was decoded by the actual Kotlin JVM producer, which verified the real source bytes and emitted phased receipts and an immutable nonempty crop packet. Those bytes were accepted by the relay. An actual relay process restart retained them; the Studio importer published/replayed the result and worker reconciliation/unpair checks passed. [Scoped evidence](phase3-wired-pilot-validation.json). The harness uses a synthetic worker, not an Android SQLite/WebView instrumented test or a provider response.

No APK was packaged or installed; installed 1.0.133 predates this wiring. No production deployment, credentials/R2 binding, enrollment, real page binding, provider prompt or managed task was created. This is locally tested source, not a claim that the live Phase 3 exit gate passed. Full ProductionRunner planning, downstream managed chapter cut/review/Editor completion, revised-input detach/rebinding and richer unknown-outcome reconciliation remain open. Expired leases never authorize publishing or re-running an old provider request.

### Release sequence for the selected Nord pilot

1. Release the compatible relay protocol with managed execution still disabled, then configure the separate Studio/device secrets, workspace and production `MANAGED_ARTIFACTS` binding. Do not deploy the local test configuration. Keep the durable daily operation/row budgets enabled; account-wide free-allowance validation remains separate.
2. Release the updated Android source through **GitHub Actions**. For the installed build, run `python3 docs/manager-agents/protocol/apk-preflight.py --device <adb-device> --require-budget --require-managed-pilot --output <evidence.json>`. Marker/signing checks are prerequisites, not proof of runtime behavior.
3. Enable Studio explicitly with `MANAGED_PILOT=1`, `MANAGED_WORKSPACE_ID`, a separate `MANAGED_STUDIO_TOKEN`, and a private `MANAGED_ARTIFACT_ROOT`. Credentials never go to the Studio browser or reporting envelopes. The workspace identifier can be displayed for phone setup; enter the device token locally on the phone, not in chat.
4. Pair **Nord → Saran (free plan)**. In Studio choose **I Became The Rogue First Prince → chapter 1 → page 1**, enroll and assign. On Nord tap **Check task / run**. Keep the dedicated tab visible; touching the app stops the local executor. No model selection is required.
5. After the saved output is uploaded, use **Import saved result** in Studio while its lease remains valid. On Nord check the task again to reconcile publication. Review the imported crop output. Validate real restart/cancel/unknown boundaries before wider rollout; never use the legacy start path to bypass a binding or reservation.
6. To roll back, stop/reconcile the task, use Studio **Unpair reconciled phone**, then the phone's **Finish unpairing**. Unknown submissions stay held until explicitly reconciled. Do not clear app data, delete bindings, or enable legacy fallback over an uncertain task.

### Latest installed Nord acceptance, 20 October 2026

Signed APK **1.0.138** contains the executor/startup/preparation and scoped release prerequisites. Sandmancer chapter 1’s old stopped-unsent task was cancelled and acknowledged; its native release produced **17 valid prepared pages with all 29 originals retained**. Sending through the installed app imported all 17 into Studio, and every phone/Studio SHA-256 matches. The next native handshake encountered an actual production daily-budget **429**, not a missing Studio configuration. Limits remain unchanged; rollover is **05:30 IST, 20 October 2026**. Native Force stop/reopen pause persistence, post-deadline delivery and the newly prepared single-page managed execution/publication remain pending. See `nord-preparation-release-live-validation.json`, `nord-prepared-pilot-studio-source.json` and `nord-native-handshake-rate-limit.json`.

### Expired saved-result recovery, 20 October 2026

Go and Plus default-settings live publication and completed-task restart checks passed on Nord. The page-6 saved-before-ack test reached the real native save boundary, then expired; duplicate prevention passed after process restart. Explicit saved-only recovery is now implemented and deployed on the relay, with local regression coverage. Its new native action needs a GitHub Actions APK; original-checkpoint recovery/publication remains unverified. See [recovery handoff](nord-expired-saved-recovery.md). These are scoped acceptance results, not completion of full ProductionRunner/downstream Phase 3 gates.

### Completed expired saved-result acceptance

Nord 1.0.142 recovered the original retained page-6 checkpoint without regeneration or lease renewal. Studio published five valid crops; direct native reconciliation and an actual changed-process restart returned no assigned page. Reservation released, pairing preserved. See [actual recovery evidence](nord-expired-saved-recovery-validation.json).


## 20 October follow-up: controlled cancellation and explicit managed page review

The Android companion repository records the installed OnePlus checks through
1.0.149 (code commit `807f808`, Actions run `39432837777`). Confirmed-submission
restart refused replay; original saved reply recovery and trusted publication passed.
Cancellation after saved output rejected both publication paths and released on the
real stop receipt. Cancellation while Stop answering was visible retained submitted
ownership until the original completed reply was manually captured as private evidence,
reported by the real phone, separately reviewed for discard, and validated locally.
Cold restart preserved release. Task history, source bindings and pairing remained.
The automatic raw-output-read/cancellation race remains isolated-test coverage.

Studio now has explicit per-page preview/review/cut controls on verified pilot output.
Approvals bind the exact source/artifact/fingerprint/cutter revision. Managed cut bytes
are immutable and revalidated on read; revoked or stale reviews cannot expose them.
102 managed workflow/interop tests, both typechecks, and an isolated synthetic browser
smoke check passed. Live read-only page 9 preview passed, while unreviewed cutting,
output access, stale approval and cancelled-page review were rejected. No production
approval or cut was issued. Existing page 9–11 authority states and all 13 chapter
bindings were preserved.

This does not complete the chapter-level review/cut projection or Editor handoff.
Chapter completion stays blocked; no legacy output copies or completion markers are
created. Full-series ProductionRunner planning/dispatch, managed chapter completion,
downstream Editor consumers, revised-input rebinding and the full production timeline
remain Phase 3 work. Phase 4 readiness is not established. The companion repository's
`docs/managed-page-review-cut.md` and patch manifest retain the detailed check record.

## Managed chapter assets and Editor bridge

Managed chapter readiness now requires every current source page to have an exact
managed binding, a verified publication, explicit current review and validated cut
receipt. Mixed chapters, missing or corrupt evidence and revoked reviews remain
blocked. Chapter approvals, old crops3 files, legacy phone progress and archive
flags cannot supply managed crop/review/export completion.

Editor metadata, staged workflow inputs, phone packages, timeline resolution and
preview serving share a read-only chapter inventory. Logical filenames include the
task and review revision, so page-local provider filenames cannot collide. Managed
references resolve only through current inventory names; positional/page-index
repair cannot silently carry an old timeline onto a new input. No managed image is
copied to crops3. Preview responses verify bytes and disable caching.

MP4 publication rechecks the crop revision and writes a private revision/hash/size
sidecar. Export listing and skip decisions require that sidecar against the current
chapter inventory and actual MP4 bytes. Revoked or changed crop inputs invalidate
export readiness. This is a crop-input fence, not a receipt for changes to narration
or timeline JSON. Managed series compression completion remains blocked until it
has its own revision-aware publication path.

Validation: 203 targeted managed, Editor, phone package, chapter and progress tests
passed in an isolated staging workspace; the server typecheck passed. Real pilot
checks remain read-only. No real page review, cut or MP4 render is issued by this
integration. Full-series ProductionRunner planning, revised-input rebinding and a
live full-chapter/Editor/export acceptance run remain Phase 3 gates. No APK or relay
deployment is required.


## Current ProductionRunner and revision/reconnect follow-up, 21 October 2026

The supported crop-page workflow now has an explicit managed ProductionRunner mode:
prepared pages are assigned sequentially through the existing sole relay authority,
matching tasks are reused, and immutable saved artifacts are automatically validated
and imported. Assignment intent is persisted before claim. All pages are preflighted
before new assignment. Cancelled, uncertain, foreign-owned and changed bindings block
the run. Stop addresses only its persisted managed tasks. This mode does not invoke
legacy narration/voiceover/clipping or select provider/model/effort settings. The
compatible native pilot still requires explicit Check task / run and publication
reconciliation; no idle/background managed polling or automatic website retry was
introduced. Active Studio status checks honor the existing durable budget pause.

A real changed source can be explicitly rebound only after the old task is verified
complete or its cancelled attempt has confirmed release. Unchanged cancelled input
cannot be retried as a fake revision. Old task/artifact/review/cut evidence remains
historical, with immutable local lineage and exact binding CAS. A lost binding reply
reuses the existing lineage instead of dispatching again. The relay also reserves the
page across preplanned input revisions, including compatibility with existing older
three-resource reservations. New claims reserve page/device/browser/profile; release
still removes only the exact attempt's rows.

The labelled one-page **Managed Phase 3 Acceptance 2026-10-20** fixture ran on the
real OnePlus 1.0.149 / Neostopzone/default settings. Initial paste verification stopped
confirmed-unsent, with no upload or Send. Inspection showed an empty composer; an
explicit resume of the same attempt submitted successfully. Studio was actually
restarted while the original reply was outstanding. The saved job became interrupted;
resume retained the same task/generation/fingerprint/attempt. ProductionRunner then
validated and published the original five-crop output and stopped at review. The real
phone reconciled publication, cold-restarted with a changed PID, and its native
inspector reported no active local hold. Pairing remains. Original production chapter
sources, 11 current bindings and pages 9–11 task histories remain unchanged.

**Supported managed crop-page Phase 3 acceptance completed on 21 October 2026.**
The owner attempted review on this exact diagnostic page and reported a save failure.
Chapter Preview's legacy chapter-wide action did not create managed revision approval.
The screen now exposes the managed page's exact review/cut controls and omits legacy
autosave for managed boundaries; server guards reject ineffective legacy approval
and cut writes. The review save was completed through the live corrected controls
for revision `89f5cae715555355bae233101ab727299e47f6a6b96594baa47931fb36fc228f`.
The UI displayed Reviewed and five verified cut files.

The real Editor preview served five verified PNGs, followed by a real four-second
MP4 with audio/video, valid duration and current crop hash/size receipt. This uses a
labelled synthetic tone and manually authored timeline, not production narration or
a provider-generated Editor timeline. A real changed diagnostic source rebound to an
unclaimed task and invalidated review/metadata/export readiness. Cancelling that
unclaimed task, restoring exact original bytes and rebinding recovered the original
verified review/cuts/export with immutable lineage, unchanged authority history and
zero added provider requests. The original production sources/bindings/history were
checked again and remain unchanged. Historical cancelled tasks remain cancelled.

Automatic late-reply capture retains isolated-test coverage; installed cancellation
acceptance retains its explicit manual-capture scope. Phase 4 transfer remains
disabled pending its own implementation and two-real-device acceptance.

241 targeted tests across 19 suites, server/client/relay typechecks, 369 Android offline
JVM tests, and both synthetic review UI paths passed. All six synthetic browser writes
were intercepted; the actual Chapter Preview save/cut was separately observed. A real
local Durable Object race and process restart preserved one owner/command. Phase 4 has
begun with the read-only reconnect foundation and two simulated worker checks;
see [Phase 4](phase4.md).
Relay version **d5043082-174e-4f20-b120-67617a4d0a84** was deployed with remote variables
preserved. No APK update was required. The Android companion repository retains the
reproducible patch, exact file hashes and scoped live evidence.
