# Nord chapter preparation hold release

The owner confirmed the failing operation is in Sleeper-Cell on the Nord. Its installed 1.0.137 has automatic unwanted-page and stitch/split preparation, but every historical managed command permanently holds its chapter in `ManagedCommandJournal.preparationBlocked`. Releasing Studio's `.managed-crops` binding does not update that app-private journal. The owner sees “Prepared 0 chapter(s). 1 held for current work, managed bindings, or existing crop output.”

Read-only phone evidence on 20 October 2026: Sandmancer chapter 1 has 29 original JPG files and no preparation receipt. Its external Crops/Sections and Crops/Output chapter directories are absent. The app-private review directory was not inspected; its separate existing-output hold remains enforced.

## Source change

- Page preparation lists individual chapter names and specific states alongside series counts.
- A chapter with a managed hold offers **Release cancelled task hold**. This makes an explicit authenticated worker-task lookup for each retained task (at most 16), with existing relay-budget backoff and response size limits. No new background polling is added.
- Local release requires no active managed/local work, a terminal cancelled task, the exact locally acknowledged stop command, matching workspace/task/attempt/generation/fingerprint/device/profile/chapter/page, unsent local and authority state, no canonical result, no checkpoint, no local retained output and no pending checkpoint delivery. Missing output fields fail closed. Paused, uncertain, submitted, saved and published cases remain held.
- All chapter records validate before any release commits. Command bodies and hashes are retained with an added authority proof; no journal tables or pairing preferences are erased. Released old task revisions reject new command admission. New input revisions still require a fresh task and normal authority checks.
- A successful release queues normal preparation; the output/review, source ownership and current-work guards still apply. Originals remain subject to the existing preparation backup/receipt workflow.

## Production preparation

Only the old Sandmancer chapter 1 pilot was cancelled after freshly confirming paused / stop_confirmed / unsent, no checkpoint and no canonical publication. This produced a new stop command requiring real Nord acknowledgment. Rogue First Prince was not changed. The archived Studio binding remains archived and must not be restored automatically after page edits. See `nord-preparation-release-cancellation.json`.

## Owner steps and remaining acceptance

1. On Nord, open Tools → Settings → Cloudflare R2 → Managed page pilot and tap **Check task / run** once to acknowledge cancellation. The task is cancelled; this check cannot run its start command.
2. Build the updated Android source using GitHub Actions and install that signed update, preserving app data. Installed 1.0.137 lacks the release feature, as demonstrated by the packaging check. No local APK build or installation was performed.
3. Open Library → menu → **Unwanted pages + stitch/split**. Under Sandmancer chapter 1, tap **Release cancelled task hold**.
4. Keep the app available until the chapter reports **Prepared**. Verify the originals backup, valid `.library-prepared.json`, actual output image sizes and updated Library state before any new managed pilot. If a different hold appears, review that specific hold rather than deleting outputs or app data.

Read-only APK check after update:

```sh
python3 docs/manager-agents/protocol/apk-preflight.py --device PHONE_ADDRESS --require-preparation --require-preparation-release
```

Source tests and installed packaging checks do not certify the live release or Android image processing. Real phone acknowledgment, installation of the updated APK, release and preparation acceptance remain pending until observed.

## Installed-phone result

On 20 October 2026, APK **1.0.138** passed the signed installed-feature check. The owner acknowledged cancellation and tapped the chapter release action. Actual phone output now passes receipt/journal consistency, complete output byte sizes, full decoding of **17 prepared images**, and Android pixel/height bounds. All **29 originals** are retained; original page 1 matches the former pilot checksum. Native source release and preparation commit are verified. Visual cut quality and unwanted-page classification, Library screen rendering, R2 synchronization and any new managed pilot remain separate checks. See `nord-preparation-release-live-validation.json`.
