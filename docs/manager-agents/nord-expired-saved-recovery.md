# Recovering the retained page-6 result after expiry

20 October 2026. Implementation and targeted local checks passed; production relay deployed. **Installed-phone acceptance passed on Nord 1.0.142.** The sequence below records the procedure; actual acceptance evidence follows. Preserve app storage, the current Neostopzone pairing and the original retained checkpoint. Do not create another page-6 task, unpair or resend the provider prompt.

## Behavior

The new phone action **Upload retained saved result only** reads and validates the existing locally saved checkpoint, including its stored hash. It sends an idempotent `recover_saved` operation for the original task/attempt/generation/fingerprint/current start command and exact checkpoint reference. The relay accepts it only for expired current work without pause/cancel/supersession or a canonical result. It records saved evidence while leaving the task uncertain, the original lease unchanged and resource reservations held. Normal browser renewal and stale normal publication remain forbidden.

The Android acknowledgment validates the complete fence, unchanged lease, checkpoint and `recoveryOnly` response. It can reconcile a locally blocked saved record, retains any superseded saved receipt in quarantine, and uploads the immutable original artifact. This separate button never launches ManagedCropRun, creates a chat, pastes text, attaches an image or submits a prompt. Invalid/unsaved/cancelled records cannot request recovery. A partial upload can be repeated with the same immutable event/artifact identities; no provider work is retried.

Studio's separate **Validate and publish recovered result** action (`POST /api/managed-pilot/import-recovered`) still requires the exact page binding, planned source identity/hash/dimensions, validated artifact bytes and verified private local destination. It sends `publish_recovered`; the relay rereads R2 and checks the current attempt and matching recovery record at commit. Cancellation during validation rejects publication. Successful publication releases reservations without renewing execution authority. Original normal publication fencing remains unchanged. This is explicit evidence reconciliation, not revival of an expired browser lease.

## Installed-phone continuation

1. Build the current Sleeper-Cell source through GitHub Actions and update Nord **without clearing data**. Keep Neostopzone paired; do not refresh pairing while the retained task owns the phone.
2. Run the read-only installed check: `python3 docs/manager-agents/protocol/apk-preflight.py --device 54a03a76 --require-saved-recovery --output docs/manager-agents/nord-expired-saved-recovery-updated-apk-preflight.json`.
3. Confirm original task/attempt/command/generation and source still match. Do not assign a fresh page. On Nord tap **Upload retained saved result only**, not Check task / run. Request the owner-observed upload message and confirmation of no new prompt.
4. Authority should now retain the same expired lease and attempt, with state uncertain, phase result_saved and the original checkpoint. Verify actual R2 upload and run `/api/managed-pilot/import-recovered` for page `040e7dd7-2fc9-42f4-a2f1-6c14bdc5be09` and task `task:sha256:c5ddae3bb5f6fb927df1533da5491e380c2902b33db771a835dd4eeecee5c9a7`.
5. Verify canonical publication and existing crop readers. Then ask owner to Check task / run to reconcile the published result; follow with restart/no-repeat check. Record actual evidence separately from local test coverage.

No deadline race is required for this saved-only path. Owner pause/cancel or revised source still requires reconciliation and must never be bypassed.

See [source checks](nord-expired-saved-recovery-validation.json), [deployment](nord-expired-saved-recovery-deployment.json), [installed prerequisite check](nord-expired-saved-recovery-apk-preflight.json).

## Actual installed acceptance

Nord **1.0.142** passed signing/recovery-marker checks. At the owner's explicit request, the agent operated the observed native controls through USB debugging. Saved-only recovery uploaded original page 6 checkpoint `checkpoint/5d23f0e8-d0ba-4b79-bbd2-7088412a4e17`. Trusted recovered import returned 200; existing readers recognize five crops with valid metadata. Authority is verified_complete/published/saved and retains the original attempt, command, generation and expired lease. Native publication reconciliation was directly observed. Force-stop removed the process; relaunch produced a different PID; the next native task check showed no assigned page. Reservation is released and pairing remains intact. No replacement prompt or attempt was invoked.

This completes this controlled saved-before-ack/process-exit/expired-recovery scenario; power loss during SQLite commit, other lost-ack boundaries and visual quality remain separate. See [direct restart evidence](nord-expired-saved-recovery-restart.json) and [validation](nord-expired-saved-recovery-validation.json).
