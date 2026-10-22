# Phase 1 — observations and Issues Manager

Implemented and locally verified on 19 October 2026. Reporting is opt-in and disabled by default in source; it is now enabled on the local production Studio and the Nord pilot phone. Source changes span this Studio repository and the sibling `MAPI/Sleeper-cell-main` Android repository. Production relay deployment and installed-phone verification followed on 19 October; see [production validation](validation.md#production-rollout-and-installed-phone). The APK was installed by the user.

## Delivered behavior

- Studio `/sleeper-cells/issues` shows manager health, last-known source time, pending delivery, chapter evidence, disagreements and grouped incidents. The global notification links to actionable incidents. Acknowledgment is durably queued and does not resolve an incident.
- `manager-report/1` carries ordered, immutable source reports, original observation time, authority acceptance time, revision/identity confidence, work state, destination availability and explicit manual overrides. It is the Phase 1 observation subset; the Phase 0 `manager-agents/1` task/control design remains a future contract, with no advertised execution capability.
- Studio persists its outbox, source sequences, observation projection and incident snapshots in `Setting.managerReporting.v1`. Compressed journals read existing plain JSON; atomic saves roll back on failure. Reconnect reports commit in batches, independent sources deliver with a concurrency limit of four, and each source retains its own ordering. Status reads use the latest committed projection with a two-second cache, and clients coalesce refresh requests. Failed deliveries retry; unchanged facts retain their original evidence time. Health-only updates do not refresh evidence.
- Android adds the default-off **Manager observations** setting, a SQLite report journal, serialized WorkManager delivery and passive adapters around existing process/profile observations. It does not navigate profiles for audits. Unknown account capacity and unsupported manager roles remain unknown/not reporting.
- The relay stores accepted events, source-sequence identity, current facts and incident projections transactionally in additive Durable Object SQLite tables. Duplicate/conflicting IDs and sequence reuse are checked. Reconnect replays original evidence with canonical incident snapshots ordered by authority revision. Events are retained for at least 90 days; current facts and incidents remain available.
- Incidents group related impacts by cause/resource, preserve recovery history, resolve only on current validated completion evidence, and reopen on recurrence. Multiple affected phones do not create duplicate notifications for the same grouped incident.
- Existing validators retain their meaning. Local module facts are captured before legacy merged phone completion can hide a missing Mac import. Existing cloud downloads/import paths record cloud availability separately from Mac import and validation. Archived/manual completion is an explicit override.
- Optional shared series/chapter IDs travel in existing library manifests. Origin identity is preserved across replicas. Legacy title/path matches remain unresolved and do not establish shared identity. Owner library page revisions can supersede stale page evidence; unknown dependency revisions remain visible.

Existing execution paths remain in place. This phase adds observation, delivery retries and notifications; it adds no task dispatch, automatic repair, provider switching or production retries. The Website UI Monitor is implemented separately in [Phase 2](phase2.md), with a separate default-off switch and pending device rollout.

## Validation

[Validation record](validation.md) records the commands and limits: all 310 Studio/server/UI tests and 276 Android JVM tests passed, client production build and relay typecheck passed, and the isolated relay integration passed both before and after a process restart. Kotlin-produced reports are consumed by TypeScript tests. The synthetic handoff test separates phone output, failed/present cloud evidence, and Mac import/validation.

Rendered UI tests cover disabled/unavailable reporting, grouped incidents, acknowledgment and separate evidence dimensions. Full visual inspection remains pending; native app accessibility inspection showed the live notification banner, but the automation surface became unavailable before a reliable Issues screenshot. Android JVM compilation/adapter tests do not substitute for device SQLite process-death instrumentation.

## Rollout and rollback

1. Review changes in both repositories and retain normal database/relay backups. Deploy the compatible relay before enabling any reporter. Its tables are additive; legacy receipts remain supported.
2. Release the Studio server/client and enable `MANAGER_OBSERVATIONS=1` using the existing relay configuration. Open Issues and verify pending delivery drains and source times remain stable across refresh/reconnect.
3. Release the Android changes through the repository's existing GitHub Actions APK workflow. No local APK build or installation is part of this change. Enable **Manager observations** on one test device after installing that compatible release.
4. Verify a real test chapter from phone output through existing cloud transfer to Mac import; check old revisions, offline delivery, restart replay, acknowledgment and recurrence. Confirm legacy production behavior is unaffected before enabling another phone.

To roll back reporting, disable the Android setting and set Studio `MANAGER_OBSERVATIONS=0`, then restart Studio. Keep compatible relay tables and both local journals so queued reports and incident history are retained for re-enablement. Do not delete queues as a rollback step. No execution ownership is transferred by these switches.

## Remaining gates and limits

The new protocol is verified on the installed Nord 1.0.126 build through the deployed production relay, including a user-confirmed app reopen and continued source sequences. The second phone was not enrolled by this verification. Forced process-death/offline-queue instrumentation, full visual review, backup restore rehearsal and a new real chapter cloud-to-Mac import remain broader rollout gates. Existing output was observed; no new generation or artifact import was started for this smoke check.

Identity coverage is additive: historical manifests without shared IDs are unresolved. Revision invalidation currently identifies page inputs; script/audio/prompt dependency revisions remain unknown where existing sources cannot prove them. Passive account facts are not quota audits. Only conditions backed by received observations produce incidents; missing unsupported reporters are shown as not reporting.

Studio and relay use a single workspace projection initially; fleet-scale growth and retention tuning have not been measured. Authentication uses the existing shared workspace relay token. Matching the report's device field to the request is an integrity check, not independent device/role authentication. Stronger authorization is required before later task ownership or privileged managed execution is enabled.
