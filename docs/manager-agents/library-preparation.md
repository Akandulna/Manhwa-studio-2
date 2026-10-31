# Android Library page preparation

20 October 2026. Implemented in Sleeper-Cell source; installed-phone acceptance awaits a GitHub Actions APK.

The previous origin-side page preparation ran from `PhoneSender.run`, before sending. Downloads without sending could therefore retain pending Unwanted pages and Stitch/split stages. The Nord's installed 1.0.135 has 20 Sandmancer chapter directories and no phone preparation or legacy stitch receipts. This is a missing execution path, not grounds to mark either stage complete.

## Behavior

- A persistent local WorkManager queue runs after each downloader chapter finishes and on app startup. Automatic mode defaults on. It needs no R2, relay, auto-send, model or profile configuration.
- Existing eligible downloaded chapters are processed on upgrade/startup. The queue operates only on chapters owned by this source device; received copies wait for their origin's prepared pages.
- The existing image engine detects repeated intro/outro art using nearby chapters, stitches/splits at suitable gutters and retains raw originals. Completion requires a committed receipt, install journal and matching output files/sizes. A partial marker is insufficient.
- Interrupted installations can recover from retained originals even when the visible chapter temporarily contains no images. Library reconciliation leaves an active installation alone, and process reporting marks its two stages active until completion.
- Managed task sources, including retained paused bindings, and existing crop/review work are held. A preparation ownership token excludes provider starts and managed command acceptance during source mutation. No task, binding or crop evidence is deleted to bypass a hold.
- Process receipt delivery is scheduled after changed batches; there is no new cloud polling loop.

## Controls

Open **Library → menu → Unwanted pages + stitch/split**, or the same menu within a series. A series' Library automation preparation gate links to this screen too. It provides the automatic-processing switch, local counts/hold reasons and **Process pending downloaded chapters** for manual retry. The screen works without a configured relay.

## Validation and release check

`./gradlew testDebugUnitTest --offline`: **331 tests, zero failures/errors/skips**. Regression coverage includes origin/replica admission, retained-output holds, exclusive preparation ownership, missing/changed output files, partial receipts, recovery with no visible raw pages, unsafe journals and old receipt compatibility. This compiles Android UI/worker wiring, but does not instrument Android bitmaps, WorkManager execution or the screen on a phone.

After installing the GitHub Actions build containing all new and changed Android files:

```sh
python3 docs/manager-agents/protocol/apk-preflight.py \
  --device 54a03a76 --require-budget --require-preparation \
  --output docs/manager-agents/nord-library-preparation-apk-preflight.json
```

1. Open Sleeper-Cell once. Check that the preparation screen shows its default-on automatic setting and catches up eligible existing chapters.
2. Confirm completed receipts and output images on disk, retained originals, refreshed Library page counts and both process stages completed only for those chapters. The retained managed pilot chapter must remain held.
3. Validate a fresh download with auto-send disabled and no R2 dependency, then a restart during preparation and a manual retry. Check that originals recover, no duplicate processing occurs and source holds remain effective.

The installed 1.0.135 currently fails the new packaging prerequisite as expected. No APK was built/installed locally and no phone chapter was altered for this source milestone. [Source/test evidence](library-preparation-validation.json), [phone baseline](nord-library-preparation-live-check.json), [packaging baseline](nord-library-preparation-apk-preflight.json).
