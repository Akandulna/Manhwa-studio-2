# Manager stabilization — 25 October 2026

This addresses the source blockers in §4 of the cross-repository code review.
Phase 7 has not started. Keep recovery disabled and stay within the pilot until
installed acceptance and the remaining review items are resolved.

## Work protected

- Studio's existing work was saved in local snapshot commit `e417a6d` on
  `codex/manager-stabilization-2026-10-25`.
- Both private output directories are ignored, including `progress-resets`.
  Production media was excluded from the snapshot.
- Android's fixes and tracked-bytecode cleanup are saved in `31a54ec` on
  `codex/manager-android-stabilization-2026-10-25`.

## Changes

- **Scheduler:** recover a free or still-owned lease after sleep or transient
  database failure; preserve fencing against a different live owner. Interrupted
  jobs retain claim IDs, abort scheduling, emit their status, and request stops
  through the existing phone-stop path after ownership is recovered. Failed
  initialization can be retried. SIGINT and SIGTERM stop scheduling, fence new
  starts, and release the lease before database disconnect.
- **Inspections:** identical facts refresh their timestamp without consuming a
  history entry or control revision. Older history chunks are archived. Inactive
  diagnosis records can leave the 128-entry active inventory without losing
  cancellation, controls, or spent budget. Pending work is not evicted.
- **Production recovery:** the recovery adapter is selected only when both its
  feature switch and the global recovery switch are enabled.
- **Relay retention:** published tasks and safely cancelled unsent tasks leave
  active inventory. Publication releases their active upload-byte and slot
  allowance exactly once. Original tasks, receipts, artifacts, and lineage remain
  addressable; archived histories do not consume lifetime inventory slots.
  Unresolved recovery actions still count against active limits.
- **Recovery admission:** Studio and relay reject new repair work when the global
  switch is off. Stop intents and retained receipts remain deliverable. New Studio
  grants require the exact operation from a fresh `diagnoseRecovery` decision;
  correction, conversation restoration, retained binding and handoff approval
  cannot bypass that check. Correction and handoff adapters remain unenrolled.

Archival retains audit records and original artifact bytes for reconciliation and
reimport. It does not delete old R2 objects or implement a cold-storage expiry
policy. Active capacity and retained storage are separate concerns.

## Validation

- Android: `./gradlew testDebugUnitTest --offline` passed; 798 tests / 99 suites.
- Studio: full `vitest run` passed; 1,655 tests / 97 files.
- Server, relay, and client: `tsc --noEmit` passed.
- Relay bundles for a neutral platform with the Cloudflare runtime import external.
- Local desktop/mobile UI fixtures passed for known-UI repair, unsent navigation,
  and account recheck. Earlier Android script checks are recorded in its fix note.

No deployment, APK build, local APK installation, or recovery enablement occurred.

## Still required

Run installed acceptance using GitHub Actions APK builds, including immediate
candidate failure, bad pairing/reset, interrupted network delivery, sleep/resume,
competing Studio ownership, and kill-switch behavior with retained receipts.

The broader security findings, recovery/UI simplification, UI-monitor impact
routing, storage housekeeping beyond active-capacity archival, and Phase 7 remain
open. This change does not claim installed acceptance or full production readiness.
