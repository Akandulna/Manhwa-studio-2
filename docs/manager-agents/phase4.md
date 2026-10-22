# Phase 4 — Multi-device coordination and reconnect recovery

Started 21 October 2026. **Read-only reconnect foundation implemented and deployed;
native reconnect and gated single-page pilot transfer are implemented; scoped installed two-phone pilot checks passed, while full Phase 4 exit remains open.** This is not Phase 4 exit
acceptance. Both installed phones have completed the scoped pilot described below.

`POST /managed/reconnect` accepts a strictly bounded current-workspace inventory of
up to eight local attempts from a device-authenticated worker. It separates current
confirmed-unsent work, saved output, completed publication, pending stop, cancellation,
obsolete fences and unknown/expired submission outcomes. Stronger local submission
uncertainty is retained. The response never grants a lease, clears a local guard,
adopts a checkpoint or repeats a provider request. Each action still needs the exact
fresh assignment renewal. Foreign attempts return no ownership details. Device
handshakes do not extend executor progress or expired leases.

New page-level claim reservations prevent two preplanned input revisions being owned
by different phones simultaneously. Existing three-row reservations remain protected
by an indexed prior-page ownership check. Stop acknowledgment with unknown submission
keeps ownership held; another phone may claim a distinct page. No reassignment of
uncertain submitted work is implemented or enabled. Confirmed-unsent pilot transfer
was added in the next milestone below.

## Verification

- Five authenticated real-SQLite reconnect tests cover two simulated workers,
  duplicate/out-of-order inventories, stale fences, stronger local uncertainty,
  completed/saved/stop states, caller isolation, bounds and read-only replay.
- Two cross-revision reservation tests cover racing Studio sessions and compatibility
  with old reservations through confirmed-unsent stop acknowledgment.
- `relay/scripts/managed-phase4-reconnect-check.mjs` passed against a fresh local real
  Durable Object SQL instance with synthetic worker credentials: one cross-revision
  winner, a stopped unknown attempt retained, a healthy distinct assignment and
  repeatable reconnect observations. An actual local Worker process restart using
  the same persisted SQL retained both states without provider replay or transfer.
- This is simulated worker and local relay evidence. APK 1.0.149 does not call the new
  reconnect endpoint. It remains compatible with the preceding managed protocol.

## Next work

The supported Phase 3 diagnostic review/cut/export and live input-revision checks
are complete; see [Phase 3](phase3.md). Native reconnect, explicit retained obsolete
observations, and confirmed-unsent single-page pilot transfer are implemented below.
ProductionRunner scheduler handoff still requires persisted attempt ownership fences;
its transfer remains disabled, including for completed or interrupted jobs whose
persisted task IDs could otherwise stop a new owner. Release any Android changes through
GitHub Actions and verify the exact two-real-device stop/continue/transfer/return
sequence before marking Phase 4 complete. Unknown external outcomes must never be
repeated automatically. Provider/profile/model fallback remains disabled.


## Native reconnect and fenced pilot transfer, 21 October 2026

Android now exposes **Check reconnect status (no provider work)**. The explicit
Check task / run path also exchanges a bounded snapshot before inbox acceptance or
provider work. The one-guard pilot sends at most one retained attempt. Replies must
match its exact fence and current local snapshot; malformed, foreign, duplicate or
weaker evidence is rejected. Observations are stored with the existing journal
record. No pairing, guard, checkpoint, outbox, lease or submission evidence is
cleared or downgraded. Obsolete/unknown/uncertain work cannot pass execution admission.
Saved output still uses the existing explicit recovery and publication paths. This
adds no startup or background polling and never replays a provider request.

The relay accepts `worker-reconnect/1` handshakes and advertises `unsent-transfer/1`.
Studio's single-page pilot has owner/lease display, explicit pause, and exact-target
transfer controls. Only an exact acknowledged **paused / stop_confirmed / unsent**
attempt with no checkpoint, upload, artifact, account binding or reservation can
transfer. Both enrolled phones must advertise native reconnect; the target also
needs a fresh matching-profile handshake. Default crop policy remains enforced.
Atomic transfer keeps task/spec/fingerprint and immutable old history, advances the
generation, reserves the new owner and emits one new start command. Lost replies
with the same event replay exactly; old renewals/checkpoints fail. Native reconciliation
observes returning old work as obsolete without clearing its evidence.

Transfer is a manual single-page pilot operation. Studio rejects any task referenced
by a persisted managed ProductionRunner job, across all job statuses. Durable fleet
scheduling and fenced ProductionRunner handoff remain open. The target must already
have the exact prepared source; native source verification still runs before upload.

Validation: **381 Android offline tests**, **254 targeted Studio/relay tests in 19
suites**, all server/client/relay typechecks, and the managed composer script pass.
A separate mocked browser verified pause acknowledgment, unsafe-state disabling,
exact target/fence, new owner display and two intercepted writes, with no JavaScript
runtime errors. A real local Durable Object with two synthetic workers passed early
transfer rejection, transfer and stale-return fences. An actual process restart with
the same persisted SQL preserved the new owner and idempotent lost-reply result.
The resulting real reconnect wire fixtures are decoded by Android JVM tests.

Applied relay **abff634f-c039-4c30-ba29-6030b43fefd5** preserves remote settings.
Authenticated readiness and a nonmutating nonexistent-task parser probe passed using
Studio's Node transport. Python transport probes returned stale protocol results and
are not accepted as readiness evidence. No live phone transfer or second enrollment
was performed. GitHub Actions must build the updated APK; both real phones must be
updated and their explicit stop/continue/transfer/return sequence verified before
Phase 4 exit acceptance. No local APK build or installation occurred.


## Installed two-phone follow-up, 21 October 2026

Both OnePlus and Note 10 Pro are installed on 1.0.151. The Note received a distinct
managed device credential; existing OnePlus credentials were preserved. Both native
read-only reconnect checks passed before assignment. An isolated prepared two-page
chapter was used; no original production source or binding changed.

The OnePlus acknowledged an assigned task's pause as confirmed unsent, then the
same task/spec transferred to the Note as generation 2. This pause preceded native
start acceptance and provider actions. The Note's read-only reconnect did not launch
its available assignment. After explicit native start, its original result saved and
published with five crops. The OnePlus cold-restarted, saw no transferred assignment,
and an old-worker authenticated renewal probe rejected its stale attempt. A separate
page ran on the OnePlus while the Note retained transferred work; it also saved and
published five crops. The OnePlus reconciled publication and its native inspector
confirmed no hold. Both authority enrollments now have reserved false.

The Note's post-publication process restart and final native reconciliation passed.
Its inspector retained the original generation-2 saved attempt and two private
checkpoint rows. Native read-only reconnect returned verified_complete without
provider work. Explicit publication reconciliation then released the local guard;
the native inspector confirmed no active hold. Both phone holds and authority
reservations are released, while pairing and private evidence remain. Reconciliation
left both task/attempt/generation/checkpoint/lease/command histories unchanged.

The immediate production baseline (17 sources, 11 bindings, page-9 review and task
histories 9–11) remains unchanged. New diagnostic crops are unreviewed and uncut.
The credential change deployed relay f6f5116d-2411-4234-8415-23a7c603f35f.
The companion Sleeper-cell-main repository retains managed-phase4-two-phone-live.md
and managed-phase4-two-phone-1.0.151.json under docs, with exact IDs and coverage.
Native obsolete-active-guard, retained-unknown multi-phone isolation and live reverse
transfer retain prior isolated scope. ProductionRunner transfer remains disabled;
full Phase 4 exit acceptance and scheduler ownership handoff are still open.


## Production claim cancellation foundation, 21 October 2026

ProductionRunner now persists a unique claim event receipt, task, device and profile
after binding and before claim dispatch. A resumed same-phone job keeps those exact
intents. It cannot adopt another job's retained attempt on the same phone. The pilot
resolves the original immutable claim receipt and compares its attempt/generation
with current ownership. Watching and importing also reject ownership changes.

The Studio-only `stop_claim` operation resolves that receipt atomically. If the
claim has not reached the authority, a durable tombstone blocks its delayed arrival;
it does not cancel a different job's claim. If the claim already arrived, only its
original attempt can stop. Lost claim replies are recoverable by the saved receipt.
Transfer to another phone and transfer back to the original phone both fence old
job cancellation. Replaying a stop never emits a second command. Task-ID-only old
jobs require explicit page reconciliation; they cannot adopt the current owner.
Studio requires relay capability `production-claim-stop/1` before production dispatch.
No Android change or new APK is required.

Validation: 265 targeted Studio/relay tests in 19 suites and server/client/relay
typechecks passed. Real SQLite tests cover persisted intents, lost claim replies,
delayed dispatch, exact stop replay, foreign roles, malformed operations, retained
ownership, and transfer away/back. A local real Durable Object passed authenticated
claim cancellation and a real Worker process restart using the same SQL. This is
synthetic authority evidence; no provider request or new live-phone assignment ran.

This completes the claim cancellation foundation only. Persisted scheduler compare-
and-swap, cross-Studio job races, and explicit production handoff remain open. The
ProductionRunner transfer prohibition stays in place for every persisted job status.
Full Phase 4 exit and remaining installed recovery scenarios remain open.


## Shared-database scheduler persistence, 21 October 2026

Studio no longer unconditionally upserts production jobs. Every save compares the
original job ID and revision inside a Prisma SQLite transaction, advances a monotonic
revision, and compares the exact previous stored JSON. New jobs also check persisted
series and device conflicts, including additional legacy phones. A retained job cannot
change its configuration or reopen after a terminal status. Old records begin at
revision zero; legacy task-ID-only command evidence is preserved, never adopted.

One process at a time owns a renewable scheduler lease in the existing Setting table.
The lease lasts 45 seconds and renews every 10 seconds. A second process can read jobs
but cannot start, cancel, overwrite or interrupt the live owner's jobs. Only an owner
that acquires an expired lease may mark old running jobs interrupted. Recovery retains
all claim receipts and sends no provider request. Lease loss fences later writes; the
old process must restart before resuming. Temporary database contention fails closed.

The runner serializes immutable report/cancel snapshots. Stop aborts scheduling and
waits for any in-flight report save before collecting original claim receipts. Stale
reports and cancelled work cannot overwrite a replacement job or restart a stage.

Validation: 277 targeted tests in 20 suites and server/client/relay typechecks passed.
Eleven new tests use actual Prisma SQLite transactions and independent clients, covering
lease contention/renewal/expiry, restart recovery, original receipts, one winning CAS,
legacy records, persisted phone conflicts, corrupt-state rollback, stale reports and
cancellation. A runner test covers cancellation during an in-flight claim save.
`node --import tsx scripts/checkProductionScheduler.mts` kills an isolated fixture
process, reopens the same SQLite database, advances only its fixture clock to expire
the lease, and verifies the original job/receipts survive recovery. No production
database or provider request is used by this script. No APK build/install occurred.

This lease coordinates processes sharing one Studio database only. Separate Studio
databases still need authority-level scheduler ownership and explicit handoff. Managed
claim/attempt fences remain the sole cloud-task ownership protection. ProductionRunner
transfer remains disabled; remaining installed recovery cases and full Phase 4 exit
are still open. No relay code or deployment changed in this milestone.


## Authority coordinator fencing across Studio databases, 22 October 2026

The relay now owns one production coordinator lease per workspace. Strict Studio-only
acquire, renew and release operations compare coordinator ID and monotonic generation
in the same real SQL transaction as guarded claims, stops and publication. Guarded work, renewal
and release recheck current ownership before cached results replay. An acquire
receipt is historical metadata and cannot authorize work by itself. A stale coordinator
cannot renew, stop, allocate or publish after takeover, including return to the same
coordinator ID. Lease renewal never extends a phone's assignment lease.

The explicit foreground Studio coordinator is shared by concurrent local managed
operations. Its authority lease lasts 60 seconds and renews during foreground progress
after 20 seconds. The final operation releases it; no startup/background relay poll
or provider retry was added. Lost acquire replies can be reconciled by the same
coordinator on an explicit retry. A new coordinator can resume an exact saved claim
receipt without allocating another attempt. Expired authority leases do not release
phone reservations, discard submission evidence or authorize checkpoint adoption.

Legacy task-ID controls cannot bypass a held coordinator. Production attempts remain
marked at the authority, so uncoordinated stop/publication and pilot transfer cannot
bypass ownership after coordinator release or from a separate Studio database with
no local job record. Manual Studio stop/import paths use the same coordinator.
ProductionRunner transfer remains disabled; explicit cross-Studio run reconciliation
and a fenced production handoff transition still need implementation.

Validation: 295 targeted tests in 20 suites and server/client/relay typechecks passed.
Tests cover competing coordinators, generation CAS, lease expiry/renewal, malformed
metadata, roles/codecs, delayed claims, cached stale stops, lost replies, concurrent
local operations, original result import, and takeover during the relay's asynchronous
R2 publication check. A real local Worker restart retained the coordinator generation,
claim receipt and task history. No real phone/provider work ran for this milestone.

Relay eefbb74f-a1a1-4b94-a610-52fc272507ed preserves remote settings/credentials.
Authenticated Node readiness and a live metadata-only check with two diagnostic
coordinator identities passed exclusion, release replay, takeover and stale controls.
Its final authority lease state is released. No task/phone assignment was mutated by
that live metadata check. Existing installed 1.0.151 phone protocol is unchanged; no
APK was built or installed. Full Phase 4 exit remains open.


## Explicit saved-run reconciliation observation, 22 October 2026

Studio's managed production card now offers **Inspect saved run (no provider work)**.
The request names the exact saved job ID and revision. Inspection loads jobs directly
without activating the local scheduler, compares the same persisted job afterward,
and returns a source/receipt/evidence digest. A changed job, ambiguous duplicate
receipts or changing authority evidence rejects the observation. The UI clears an
observation when job ID/revision changes and labels it read-only; no resume or
transfer permission is granted.

The authenticated relay receipt endpoint reads the original immutable claim event
without replaying claim or allocating an attempt. It distinguishes a recorded claim,
a missing receipt and a delayed claim blocked by Stop. Studio verifies the current
source binding and exact original attempt/device/profile/generation/fingerprint, then
reports current unsent, original reply/upload waiting, original saved bytes, verified
publication, obsolete ownership, retained uncertainty/expiry, changed input or legacy
task-ID-only evidence. Prepared pages with no persisted claim are counted without
planning or assignment. Missing receipts never adopt the timeline's current owner.

Validation: 305 targeted tests in 20 suites, all server/client/relay typechecks and
a separate mocked browser check passed. Ten added tests cover pure original receipt
reads, strict role/task/workspace correlation, no SQL mutation, exact job revision,
legacy evidence, changed sources, obsolete owners, retained unknown/expired work,
saved/publication observations and changing authority evidence. The browser used two
intercepted inspection requests, verified obsolete-owner display and stale report
clearing, and emitted no JavaScript page errors or provider work.

Relay a936a142-e65f-4d84-a05e-3ae19e95e1e6 preserves settings and credentials.
Authenticated readiness and a read-only missing-receipt probe on the completed
diagnostic task passed without changing task history or coordinator state. Production
handoff remains disabled. Durable cross-Studio run adoption/reconciliation and an
explicit fenced production handoff transition remain required; this milestone only
observes retained saved-run evidence. Remaining installed recovery cases and full
Phase 4 exit remain open. Android is unchanged; no APK build/install occurred.


## Explicit inspected resume in the existing Studio database, 22 October 2026

The managed run inspection now offers **Resume inspected run** only for interrupted
or failed runs with complete acceptable original evidence. The request pins job ID,
revision and inspection digest. Studio acquires current authority coordinator ownership,
re-inspects exact sources/receipts/attempts, rejects a changed digest or saved job,
and persists the resume decision with the original configuration and claim receipts
before execution. Prepared task identities are pinned too; changed page scope blocks
new claims. The resumed run has a new local job ID while retaining original authority
task/attempt/claim identities. No provider retry is introduced by resume.

The shared database compares the original job ID/revision during replacement and
requires the inspected-resume proof for retained failed/interrupted managed jobs.
The persisted decision cannot change afterward. Generic Start cannot bypass explicit
resume, change a retained run's phone/configuration, or reopen a cancelled run. Missing
receipts, obsolete attempts, changed inputs, expired/unknown outcomes and stop-pending
work remain blocked. Review remains a separate human decision; no review/cut/export
approval is inferred from resume.

Validation: 323 targeted tests in 21 suites, server/client/relay typechecks, process
kill/restart persistence and an intercepted browser fixture passed. Eighteen added
cases cover strict requests, allowed original evidence, retained unsafe cases, changed
job/digest/scope, cancellation, immutable durable resume proof and failed persistence.
A real-SQLite authority integration reused the original saved result under coordinator
ownership, published it and retained exactly one attempt. Browser checks verified
unsafe disabling, exact job/revision/digest, explicit resume, stale-report clearing
and displayed durable decision with four intercepted requests and no page errors.

This resumes a job already persisted in this Studio database. Import/adoption of a
run missing from another Studio database and explicit production phone handoff remain
open. Production transfer stays disabled. Relay/Android protocols did not change; no
relay deployment, APK build/install or real provider request was needed. Remaining
installed recovery scenarios and full Phase 4 exit remain open.


## Production adoption, fenced handoff and managed fleet, 22 October 2026

This milestone supersedes earlier production-transfer-disabled statements. Portable
original runs can now be adopted into an empty Studio database without dispatch,
then inspected and explicitly resumed. Authority receipt checks, source binding and
absence CAS reject invented receipts and destination overwrite. Real independent
SQLite Studio databases preserve both original jobs and the one authority attempt.

Explicit production pause and handoff persist transfer/target-claim event IDs before
remote allocation. Authority transfer and its independently replayable new claim
receipt commit atomically; local replacement is derived strictly from the saved
intent. Lost replies retain that intent. Old jobs/workers remain fenced after transfer
and reverse transfer; cancellation blocks delayed transfer and local apply.

An explicit fleet of up to eight phones assigns one page per phone. Healthy workers
continue distinct pages while the original unknown task remains held. Default model
policy, exact prepared scope and review boundaries remain enforced.

Installed APK 1.0.151 completed an isolated ProductionRunner round trip: OnePlus
unsent Stop, Note generation-2 handoff and inspected resume, Note unsent Stop,
OnePlus generation-3 reverse handoff and inspected resume, then final cancellation
and actual Stop acknowledgment. The cancelled diagnostic has three starts, three
stops, two durable handoffs and no checkpoint/provider request. Both native reconnect
checks ended with no local hold or assignment. Original jobs, 17 sources, 11 bindings,
page-9 review and original task histories 9–11 are unchanged.

338 tests in 21 suites and three typechecks passed. Browser fixtures cover exact
fences, unsafe disabling, persisted-intent retry, adoption and explicit resume. A real
local Worker restart preserved transfer, new claim receipt and obsolete-stop proof.
A killed/restarted scheduler preserved original receipts. Outage, competing scheduler,
lost acknowledgment and cancellation-race cases retain their isolated-test scope.

The new native explicit obsolete confirmed-unsent stop reconciliation is implemented
and unit-tested against a real Worker wire fixture. It requires idle original pairing,
a fresh authenticated old-stop/new-generation proof, and no related local external
action or saved checkpoint. Only that obsolete guard is released; history and pairing
remain. A one-use Stop receipt pause enables controlled installed lost-ack acceptance.
GitHub Actions must build the APK; none is built/installed locally.

Relay cf642aa4-6564-4a1c-91fd-846208623f42 advertises production-handoff/1 and
obsolete-unsent-stop/1. Full Phase 4 exit remains open: update both phones, verify the
obsolete active guard through restart/transfer/explicit reconciliation, complete the
remaining installed uncertainty/interruption checks, then record final preservation.
