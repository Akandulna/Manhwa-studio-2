# Clipper / Metadata split (v5.1)

The paired Sleeper Cell branch is `v2`. Local verification used beta builds.

1. ChatGPT Classic or AI Studio four-stage clipping produces pointer JSON only. Both inspect actual crops and audit annotated sources.
2. Sync pointers in Studio. Correct them in Preview, explicitly mark reviewed, then Crop Sections. Metadata is not a prerequisite for cutting geometry-only pages.
3. A successful complete cut binds approval, source hashes, exact normalized pointers, filenames, rounded pixel bounds and output hashes. Studio publishes only `sleeper-cell-metadata-job/1` JSON at `shared/metadata-jobs/<series>/<chapter>/<page>.page.json`.
4. Sleeper Cell Metadata verifies originals/scripts/generations, recreates exact temporary PNG crops, and uses AI Studio for descriptions and script associations together. Accepted batches survive interruption; images are deleted after atomic JSON save. Script-only changes reuse visual descriptions.
5. Studio **Sync Metadata** (or ordinary Sync JSON) imports `sleeper-cell-metadata-result/1` JSON from `metadata/<series>/<chapter>/<page>.page.json`. It never changes approved geometry, review records or crop PNGs. Editor readiness checks the current approved cut and script again.

Phone Status → Run Automation → Metadata selects approved unfinished chapters and one updated phone. Provider is fixed to AI Studio. The deployed relay now supports `metadata_start` and advertises `metadata-automation/1` (version `b1cd0366-acb3-40cf-bb6f-a2d2a0e703f6`, 100% deployment). Existing bindings and newer live patches were preserved. Local Metadata is available in the phone Tools screen.

Existing complete legacy exports remain readable. Managed/mixed chapters are explicitly unsupported until a compatible immutable-artifact sidecar contract exists. Library production automation stops for manual review; start Metadata separately after review/cutting. No automatic human approval is added.

Unit/regression tests cover pointer-only import/cutting/editing, cut/source/script freshness, revoked review, exact crop inventory, empty pages, idempotent metadata attachment, and no mutation of pointers/review/crop bytes. Both provider pilots, the scoped multi-chapter dispatch and recovery checks passed. Cropped-image archives are never transferred through R2 by the new Metadata path.

## Completed rollout validation — 1 November 2026

The paired implementation is on Android `v2` and Studio `v5.1`. Final OnePlus beta: `1.0.217-beta.clipper-metadata-rollout-20261101-r8`, SHA-256 `31db2fa5bfe3d08f15a883a2920cd7b0742ca22625b24429c67f5a82f57de636`. Production stays `1.0.206`. Both required offline Android suites passed (987 tests each); beta packaging passed. Studio's affected regressions/UI passed (115 tests), dispatch/sync regressions passed again (35), and final cleanup/Metadata regressions passed (11). Server/client/relay typechecks and Vite build passed.

- Classic ChatGPT Chapter 001: six pointer-only crops → actual operator review → Studio cut → approved JSON job → AI Studio Metadata → confirmed upload/cleanup → Studio import. Repeated import was idempotent. All 12 protected source/pointer/review/crop/script/cut files remained unchanged.
- AI Studio four-stage Chapter 002: ten inventory shots, nine initial candidates, four actual-crop inspection batches and three source audits produced seven pointers. The operator corrected them to six and approved them. Studio cut all six; returned Metadata passed after one rejected non-JSON reply and a same-conversation correction without repeated image uploads. All 12 protected files remained unchanged.
- Two-chapter Metadata dispatch skipped completed Classic work and generated only Chapter 002. Both chapters passed Editor's crop/Metadata prerequisite. Voiceover/alignment/timeline gates remain separate.
- Existing approved Chapter 007 of `I'm Gonna Annihilate This Land`: all 13 pages / 74 crops completed, uploaded, cleaned up and imported with zero errors. Among 102 protected files only its 13 Metadata files changed. Upgrades/resume retained completed pages; two tabs processed the remaining nine pages without retries.
- Final r8 recovery rebuilt both pilot result files from complete accepted checkpoints in 1.078s with zero AI requests or image renders; output/checkpoint bytes stayed identical. Completion correctly reported both pages. This fixes an earlier parallel-lane completion-message count race.
- Shared deletion now includes Metadata jobs/results and nested phone crop-work directories. Similarly named series are protected by regression coverage. The live synthetic-series deletion verified this behavior.

## Observed timings

| Pilot / stage | Time |
| --- | ---: |
| Classic pointers, one page | 16m16.387s, including quota retries |
| Four-stage pointers, same source | 18m11.257s, including visual correction rounds |
| Four-stage inventory | 303.321s reply + 6.464s upload |
| Four-stage corners | 147.838s reply |
| Four-stage crop inspection | 138.547s replies + 6.970s uploads, four batches |
| Four-stage source audit | 303.733s replies + 10.107s uploads, three rounds |
| Classic chapter Metadata | 115.666s for six crops |
| Four-stage chapter Metadata | 9m28.526s, including rejected 485.529s reply and accepted 40.171s correction |
| Existing chapter pages 5–13, two tabs | 12m44.053s total for nine pages |
| Those nine pages, individual wall time | Mean 163.877s, median 131.968s, range 74.581–277.289s |
| Those nine pages, render/upload/AI waits | Means 2.494s / 3.673s / 122.225s |

Human review and phone queue time are separate. Component waits are included in batch/run totals; overlapping page times must not be added as elapsed time. Different provider settings, slicing, devices, quota effects and correction counts prevent a valid before/after speedup claim. Earlier externally force-stopped attempts are excluded from completed samples.

## Requested cleanup

The original Chapter 007 Metadata files were restored from backup and all 102 protected files match their original SHA-256 hashes. Its temporary phone Metadata state, Studio job/cut-proof files and 39 cloud test objects were removed. The synthetic series was deleted through shared-library deletion; Studio data, phone workspace folders and cloud objects were verified absent. The scoped cloud listing showed zero remaining test objects. The deletion tombstone prevents stale replicas reviving the test series.

Implementation, regression tests and this validation record are retained; production app/data are preserved.


Local scratch cleanup removed 216 explicitly inventoried task files/directories after restoration checks. After reconnection, the OnePlus serial/model were verified and its remaining 17 temporary UI-dump XML files were removed by exact path; all 17 paths were verified absent. The released reservation/cleanup manifest was removed. Requested cleanup is complete; implementation, regression tests and validation records are retained.
