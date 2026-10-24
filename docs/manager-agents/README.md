# Manager agents: implementation and validation

**24 October continuation update:** Read the [completed agent-reporting and Cloudflare usage scope](../../../MAPI/Sleeper-cell-main/docs/agent-reporting-continuation-update.md) before continuing overlapping work. Source implementation and local validation are complete; rollout, installed acceptance and measured savings remain pending. Reconcile older pending items with that update; reuse the delivered implementation rather than starting it again. Other phase gates remain unchanged.

Updated 19 October 2026. Phase 0 defines contracts and failure behavior. Phase 1 observation and Issues Manager source implementation is complete and locally verified, with reporting disabled by default in source. The production relay and local Studio are now updated, and native reporting is verified on the user-installed Nord APK. Phase 2 Website UI Monitor source is now implemented and locally validated, with the Nord ChatGPT composer baseline/control pilot verified. Phase 3 authority, authenticated API, Android journal, legacy start guards and immutable artifact storage/validation adapters and crop read projections and immutable local cutting are implemented and locally tested; executor and cut-completion/downstream integration remain in progress and managed execution remains disabled. See [Phase 1 handoff](phase1.md), [Phase 2 handoff](phase2.md), [Phase 3 handoff](phase3.md), and [validation](validation.md).

Read in order:

1. [Protocol decisions and boundaries](decisions.md)
2. [Entry points and module ownership](inventory.md)
3. [Migration, compatibility, evidence, and rollout](migration.md)
4. [Acceptance matrix](acceptance.md)
5. [Wire schema](protocol/records.schema.json), [shared fixtures](protocol/fixtures.json), and [transition fixtures](protocol/transitions.json)

The Phase 0 documents retain proposed future task/control designs. Phase 1 uses the narrower `manager-report/1` observation contract described in the handoff; the full Phase 0 schema is still an implementation target for later managed execution.

Run the isolated contract checks from Studio root:

```sh
node docs/manager-agents/protocol/verify.mjs
server/node_modules/.bin/tsc --strict --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck docs/manager-agents/protocol/contracts.ts
```

The verifier uses the Ajv installation already present under client/node_modules (ESLint dependency); it makes no network calls and writes no application state. JSON is the single shared fixture corpus for TypeScript and Kotlin. [The TypeScript consumer](protocol/contracts.ts) is compile checked; [the Kotlin consumer](protocol/ContractFixtures.kt) has now passed in the Android JVM test suite through the supplied [Gradle test-source configuration](protocol/android-fixtures.init.gradle). It is still not part of the installed phone application. See [Android and live validation](validation.md) for commands, results, and scope.

Phase 0 review gate: source inventory and intended enrollment policy recorded; all ten record families and safety transitions have executable fixtures; crop-page checkpoint boundaries inspected. Kotlin fixture decoding and existing live receipt delivery/replay are verified. Phase 1 adds durable observation queues, incident persistence, source ordering and redaction checks. The Nord pilot has production delivery/replay and app-reopen evidence. Broader fleet rollout, migration restore rehearsal, device timing measurements, and owner-selected execution policy remain release gates. Managed dispatch remains disabled until its own gates pass.
