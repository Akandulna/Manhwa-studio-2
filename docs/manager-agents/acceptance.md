# Acceptance and phase evidence

**24 October continuation update:** Read the [completed agent-reporting and Cloudflare usage scope](../../../MAPI/Sleeper-cell-main/docs/agent-reporting-continuation-update.md) before continuing overlapping work. Source implementation and local validation are complete; rollout, installed acceptance and measured savings remain pending. Reconcile older pending items with that update; reuse the delivered implementation rather than starting it again. Other phase gates remain unchanged.

All PRD A01–A32 cases are mapped below. “Specification” checks exercise the Phase 0 oracle/schema, not production implementation. No end-to-end acceptance scenario is claimed passed yet. Each later phase must attach deterministic execution evidence before marking its gate complete.

| PRD | Implementation phases | Required fixture / test target | Phase 0 evidence and remaining work |
|---|---|---|---|
| A01 | 3, 4 | Concurrent claim, one winner; atomic reservations | Task/attempt/reservation contracts; real DO race pending |
| A02 | 3, 4 | Overlapping starts from two Studio sessions | Entry-point enrollment policy; race pending |
| A03 | 3, 4 | Lost acceptance | disconnect before acceptance is unknown |
| A04 | 4, 6 | Disconnect after submission | disconnect after external submit |
| A05 | 4 | Reassigned worker returns | old acceptance cannot resume |
| A06 | 3, 4 | Late stale-owner upload | old owner cannot publish |
| A07 | 3, 7 | Saved output before report crash | saved-before-ack reused at valid publication; actual file reconciliation pending |
| A08 | 3, 8 | Mac/relay restart | Outbox replay specification; durable DB restart pending |
| A09 | 3, 6 | Cancel/pause during recovery | cancel blocks scheduled recovery; pause blocks recovery execution |
| A10 | 1, 3, 7 | Changed dependency revision | old revision cannot publish; replaced input supersedes running attempt |
| A11 | 5, 6 | Eligible quota fallback | Account/reservation/attempt contracts; playbook pending |
| A12 | 5 | One quota shared across profiles | Scoped account identity contract; concurrent quota eligibility pending |
| A13 | 6 | Upload allowance vs timeout | Submission outcome and action-boundary decision; adapter classification pending |
| A14 | 5, 6 | Confirmed sign-out | Account unknown vs signed-out enum; routing/playbook pending |
| A15 | 5 | Failed account audit | Unknown login/plan golden fixture; adapter behavior pending |
| A16 | 5, 6 | Estimated reset passes | Decision: reset triggers recheck, not capacity; scheduler pending |
| A17 | 2, 6 | Missing button | Baseline variants/uncertain report contract; bounded recovery pending |
| A18 | 3, 6 | Click succeeded, acknowledgment lost | Unknown submission hold and replay specification; restored-page inspection pending |
| A19 | 5 | Audit while session busy | deferred_busy account state; idle reservation checks pending |
| A20 | 1, 6 | Multi-device underlying failure | Incident grouping/replay spec checks; durable incidents pending |
| A21 | 1, 6, 7 | Cloud succeeds, import fails | Observation fixture distinguishes phone validated/cloud uploaded/Mac missing; retry integration pending |
| A22 | 1, 3, 4 | Stale/out-of-order receipt | Sequence/source/revision/freshness specification checks; reporter integration pending |
| A23 | 3, 4, 7 | Legacy/manual start bypass | Inventory + default-block enrollment policy; enforcement pending |
| A24 | 8, 9 | AI disabled/unavailable | No AI dependency in contracts/core policy; runtime outage case pending |
| A25 | 5, 7 | No suitable profile | Wait-only fallback policy; eligibility selection pending |
| A26 | 3, 7 | Required review outstanding | review gate blocks publication |
| A27 | 2 | Provider UI changes | UI contract/chain fixtures for all three providers; recorded adapter comparison pending |
| A28 | 2 | Cosmetic UI change | confirmed_info + notified fixture; notification persistence pending |
| A29 | 2 | Streaming/loading/overlays | Supported-state and transient classification policy; page fixtures pending |
| A30 | 2 | Variant-specific change | Variant-scoped UI record; independent-device detection pending |
| A31 | 2 | Offline UI report replay | Stable change/handoff/notification identities; durable two-hop delivery pending |
| A32 | 2, 6, 8 | Change during active session / busy audit | Idle-reservation and baseline-acceptance rules; monitoring noninterference pending |

## Validation record

- `node docs/manager-agents/protocol/verify.mjs`: ten record families accepted, invalid mutations rejected, safety transition cases and ordering/replay/freshness/grouping/UI-chain specification assertions pass.
- Isolated TypeScript compile of `protocol/contracts.ts`: passes. Regenerate using `node docs/manager-agents/protocol/generate-types.mjs`; schema is the source of truth.
- Kotlin `ContractFixtures.kt`: compiled and passed using the existing Android JVM suite plus a temporary test-source configuration. Full suite: 273 tests, zero failures/errors/skips. The reusable init script also passed a focused rerun. These are JVM fixture tests; the decoder is not installed in the released app.
- Follow-up live verification: Android 15 / Sleeper-Cell 1.0.123 detected by USB; two phones returned correlated sync/scripts/crops receipts through the existing configured relay, and a diagnostic desktop reconnect replayed them without changing source/receipt timestamps. See [validation evidence and limitations](validation.md). No generation, APK build/install, production data import/publication, phone disconnect, or website navigation was performed.

## Phase 0 handoff

The authority, identity, record families, action boundaries, uncertain/cancel/supersede behavior, pilot page boundary, entry-point enrollment classification, manager/stage mapping, compatibility/migration design, isolated fixtures, evidence policy, and wait-only default are now specified. Existing production execution stays unchanged. Phase 1 starts with observation/incident adapters; it must retain original timestamps and separate phone output, cloud object availability, and Mac import before adding the Issues inbox.
