# Relay free-tier budget

**24 October continuation update:** Read the [completed agent-reporting and Cloudflare usage scope](../../../MAPI/Sleeper-cell-main/docs/agent-reporting-continuation-update.md) before continuing overlapping work. Source implementation and local validation are complete; rollout, installed acceptance and measured savings remain pending. Reconcile older pending items with that update; reuse the delivered implementation rather than starting it again. Other phase gates remain unchanged.

19 October 2026. Applies to `sleeper-cell-relay` and its single `main` SQLite Durable Object. Production Worker version `2b02e41b-d1ee-4d9c-b7a9-6c191168ebac`; prior compatible version `64a8e59e-99f8-457d-8c55-749236aef14d`.

| Dimension | Cloudflare Free allowance per UTC day | Relay protection |
|---|---:|---|
| Worker requests | 100,000 | Reduce producer traffic; 100,000 admitted relay operations shared with DO events. This is **not** a cap on ingress invocations. |
| Durable Object requests | 100,000 | 100,000 admitted HTTP/WebSocket-handler/alarm/close operations. Pings use hibernating auto-response. Rejected calls and handshake attempts still consume platform requests. |
| SQL row writes | 100,000 | 100,000 local counter ceiling, with 10,000 reserved before each query; work pauses around 90,000 measured writes, before Cloudflare would fail operations. |
| SQL row reads | 5,000,000 | 5,000,000 local counter ceiling, with 10,000 reserved before each query. |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [SQL cursor billing metrics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#returned-cursor-behavior).

## Behavior

**25 October 2026, deployed 00:44 IST (19:14 UTC 24 October) as relay `af54f66b-1f89-4b2f-9c49-64a772f4034b`** (previous `5ca19495-8e71-49d3-a0c8-2491b3293cb0`; this deployment also carried the then-undeployed Phase 6 relay source). Studio restart and the Android GitHub Actions release are pending. Local ceilings now equal the Cloudflare Free daily allowances above (previously 20,000 operations / 3,000,000 reads / 60,000 writes, which paused the relay at about 50,000 writes on 20 and 24 October). The 10,000-row reserve keeps the pause graceful. Same change:

- The manager projection is stored one row per observation, incident and chapter revision (`manager_observation_rows`, `manager_incident_rows`, `manager_revision_rows`). A report reads and writes only the entries it names, and only changed entries are written. Local Wrangler measurement on a 15,000-observation store: updating an existing observation fell from 145 reads / 76 writes to 9 / 9; a 16-report batch from 2,272 reads to 114.
- The one-time move from the serialized chunks copies 2,000 entries per fact report (about 4,000 row writes each; about 30,000 in total for 15,000 entries), with progress committed per slice. Uncopied entries are read from the chunks meanwhile. The chunks are never written again and are kept for rollback; a rolled-back relay sees the state as it was at the move.
- The usage row is saved two seconds after the last unsaved operation (a pending timer prevents hibernation first), at once after 20 unsaved operations, and on every operation near a limit. A crash inside that window can lose at most those seconds of counts.
- `GET /usage` adds `rows`: rows read/written per signal (`manager_fact`, `manager_health`, `http_ws`, `alarm`, `checkpoint`, …), each manager event in a batch counted separately.
- Studio publishes its process snapshot at most every 30 seconds while it keeps changing (first change after a quiet period: 600 ms). Android sends each unprompted receipt kind at most every 30 seconds, with one queued worker per kind that builds the latest receipt when it runs; answers to requests are not paced.

- Counters live in one SQLite integer-primary-key row, survive process restarts and deployments, and reset at **00:00 UTC / 05:30 IST**. Existing report/receipt data is retained at rollover. SQL results are fully consumed before their `rowsRead`/`rowsWritten` metrics are accumulated; index work is included by the platform cursor. Checkpoints include conservative bookkeeping and explicit alarm-write accounting. Rolled-back report work still counts locally.
- An exhausted budget returns **HTTP 429 + Retry-After** until the next UTC day. Reporting outboxes retain their immutable events. No new report is acknowledged as accepted merely because the budget is exhausted. Rejected retries do not continually write the budget row. One alarm is scheduled at reset instead of continuing minute-by-minute writes while paused.
- Relay commands also pause at exhaustion; the budget does not cancel ongoing phone work. Local phone controls remain available. This is deliberate reduced availability to preserve free-tier headroom.
- Studio health-only reports are spaced five minutes apart; changed facts are immediate and retain original observation times. Reporter health becomes last-known after fifteen minutes. Studio persists the manager-delivery pause across restarts.
- Android source similarly spaces manager health reports five minutes apart, honors `Retry-After` and skips scheduling additional manager delivery workers during its persisted pause. **These Android changes require the next GitHub Actions APK.** Installed 1.0.128 still has its earlier cadence/backoff, but the server-side database protection is already deployed.
- Replaced repeated event-history sequence backfill on object wakes with the already-maintained sequence table. Old source-sequence collision tombstones remain intact. Existing deployed data already has this table populated.
- Indexed event expiry deletes at most 128 old events per report. The one-time expiry index is created only when the existing event table has at most 5,000 rows; larger legacy stores defer cleanup, retaining history for a separate migration. Schema migrations are checkpointed rather than rerunning receipt cleanup on every wake.
- The pilot admits at most eight registered phones, eight phone sockets and four desktop sockets. Receipt origin admission is also bounded. Manager replay pages in primary-key order, 128 rows per query, and deduplicates raw batch bodies before parsing. There is no 5,000-fact truncation; the row budget can defer a replay if its remaining allowance is insufficient.

## Inspect usage

Open [Studio relay usage](http://localhost:3002/api/managers/relay-usage). This on-demand endpoint caches results for 30 seconds and keeps credentials on the server. The relay's authenticated `GET /usage` also remains available during a pause.

These are **relay-local protection counters**, not the Cloudflare account bill. Initial-day counters begin at deployment; earlier traffic that day is not retroactively measured. Diagnostic reads/bootstrap overhead, failed platform operations and other account workloads require Cloudflare's own analytics for authoritative totals. Buffers leave room for those costs but do not prove an account-wide bound.

An invocation counts before Worker code can reject it. No in-Worker counter can guarantee fewer than 100,000 Worker requests under arbitrary incoming traffic. Other Workers/DOs share the account allowances too. Keep the account on Workers Free if exceeding the allowance must result in service failure rather than paid overage; do not interpret this implementation as an account-level spending cap. No billing-plan change was performed. Account-wide daily analytics and a full UTC-day production observation remain required to certify real operating headroom.

## Validation

- Studio/server: **44 files, 333 tests passed**. Budget tests cover persisted counters, actual query metrics, alarm/checkpoint writes, UTC rollover, pre-query read/write reserves, and refusal to raise the operation cap.
- Relay TypeScript and Studio server build passed.
- Android offline JVM: **291 tests**, zero failures/errors/skips; no APK packaging/install.
- Local real SQLite relay: existing three-provider reporting/incident/owner-review/replay checks passed. Replay passed again after stopping and restarting the process with the same store.
- Local cutoff store with `RELAY_DAILY_OPERATIONS=3`: three requests accepted; the fourth returned 429 with Retry-After. Row-write count did not increase on rejection. After a process restart the same cutoff remained in force. Exhausted requests are drained before responding, without retaining payload bytes; cancellation alone was insufficient for the forwarded request stream.
- Initial production inspection after deployment: **38 admitted operations, 42,693 row reads, 2,453 row writes**, including migration/reconnect work. Studio was healthy with zero pending reports and no delivery error. This is a deployment smoke snapshot, not a one-day projection.

Local cutoff harness: `node relay/scripts/budget-check.mjs`, then restart its isolated relay/store and run `node relay/scripts/budget-check.mjs --replay-only`. It is localhost-only and uses a test token. Never manufacture budget exhaustion or synthetic reports against production.

Production smoke testing initially exposed an overly small fixed replay bound, which rejected desktop upgrades for the existing store. Corrected it to indexed 128-row pages with raw-batch deduplication; stored facts were retained. Final production version is recorded above. The full local 6,001-row replay test delivered all three distinct seeded report bodies once, and the original incident replay checks still passed. Both production phones and Studio reconnected after the correction; the queue was empty with no delivery error. A later local-counter snapshot was 567 admitted operations, 408,061 reads and 3,808 writes, including deployment/migration/diagnostic reconnect work. Initial-day counters remain partial-day totals.

After the pagination correction, the live receipt/replay smoke check passed: 26 fact-bearing batches replayed with original source/authority timestamps, 472 authority-accepted Nord facts, no delivery error and zero queued Studio reports. One existing production run was present before and after; the check did not start or stop it. Local test relays were stopped.


## Phase 3 artifact storage boundary (source only)

The disabled managed artifact adapter reserves durable slots before object writes: at most 256 slots / 64,000,000 bytes, one slot per task, maximum 1,000,000 bytes per artifact. Failed/orphaned allocations stay charged; a retry with different bytes or another artifact ID is refused. Conditional R2 writes and readback prevent blind replacement. Upload/publication is explicit and has no polling or retry job. These slots are separate from the daily measured SQL/operation budget, which still admits every managed API call. Account-wide R2 storage/Class A/Class B usage and the existing four free allowances still require account-level evidence before rollout. No managed R2 binding or production traffic was added during this milestone.


The crop-reader integration reads private verified publication receipts and source evidence locally. It adds no polling, Worker/DO requests or R2 GETs to image lists/status reads. Binding and publication invalidate the existing local status cache through local events. Artifact recovery still requires an explicit import/replay; reader failure never triggers a generation or legacy import fallback.


The explicit managed local cutter renders from private verified crop publications and source images. It writes task-scoped PNG derivatives and a local receipt only; it has no relay/R2 calls, timer or automatic job. It does not upload cut PNGs or consume additional account-wide cloud storage. Downstream/cloud cut publication is still disabled.


19 October Nord wireless verification found an oversized single-row manager projection (`SQLITE_TOOBIG`) despite an incoming report of only 10 KB. Relay `c3c2651e-c129-4775-a54a-5eb9e592e7f6` now stores that projection in bounded transactional chunks, avoids splitting Unicode surrogate pairs and updates only changed chunks. Chunk SQL remains metered by the daily row budget. Existing reports were retained and drained after deployment. This fixes per-row storage growth; it does not certify account-wide daily limits. Retain the chunk-aware decoder on rollback. See [Nord deployment/usage evidence](phase3-nord-wireless-verification.json).


19 October 2026 recovery follow-up: Studio and Android source now honor numeric and HTTP-date Retry-After without shortening valid delays longer than one day. Both persist the longest pause and check it before sending; reporting and managed Android transport share the preference gate. Real local relay cutoff survives restart with row writes unchanged at 37 on rejected retries; real HTTP/disk-journal recovery and Android JVM policy restart checks passed. See [scoped evidence](phase3-rate-limit-recovery-validation.json). This does not certify installed-phone worker/preference crash behavior or account-wide free allowance. Android requires a future GitHub Actions release; no APK was packaged or installed.
