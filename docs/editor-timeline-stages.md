# Small timeline batches

In **Editor 2.0 → series → chapter**, choose **Small batches**. Copy the current prompt into a fresh AI chat, paste its JSON response, and choose **Validate & continue**. Close the dialog at any point and reopen it to resume. After review passes, choose **Use timeline JSON**, then **Start Processing → Preview → Export / Re-export**. Using the result replaces the chapter's current paste; opening the dialog does not change it.

Routing and selection prompts include a response template listing every required beat. If a response fails validation, the dialog names missing or invalid IDs and offers **Copy correction prompt** for the same batch. The rejected response is saved locally and restored when the dialog reopens; **Reload current batch** refreshes its instructions without resetting accepted work. A single JSON object wrapped in normal AI prose or Markdown is accepted, but ambiguous multiple objects are rejected. Completing the visual index is an intermediate step: narration matching, crop selection and review must finish before a final timeline is available.

For automatic execution, choose **Small batches (updated phone)** beside **Send to phone**, send the chapters, then start **Editor 2.0 timelines** in **Run automation**. Updated Sleeper-Cell builds expose Editor's ChatGPT mode, model and effort there. Empty choices retain the account's current model for staged jobs. The phone opens a fresh chat for each task, checkpoints every accepted reply, and uploads only a completed, structurally checked timeline. **Fetch from phone** brings it back for processing and preview. Install the updated Sleeper-Cell APK before using staged packages: older builds cannot read package schema 3. Existing one-shot packages remain schema 2.

The staged prompts are built in. Settings' existing Editor prompt continues to control **Copy All / one-shot**. One-shot remains the default while visual accuracy is evaluated. Automatically republished chapters remember the workflow used on their last explicit send, per language.

The stages are:

1. Index small visual groups (up to eight crops), retaining a group summary and a short label for every crop. The visual index is reusable between English and Hinglish when the source crops and descriptions match.
2. Route up to six narration beats to visual groups. Large indexes are searched in windows and nominations are compared in further small tasks. Audio sections are independent of image pages.
3. Select crop IDs for small beat groups, using at most twenty candidates and neighboring alternatives. Batches split for size; unusually verbose candidates use their indexed labels, followed by full-description review.
4. Review selections against the narration and full crop descriptions. Only failed or uncertain beats enter repair, searching expanded candidate windows and receiving a fresh review.
5. Assemble the existing timeline schema in code with the original alignment ranges and actual exported filenames. Repeat/backward-order checks remain visible for preview review.

Every prompt includes its task instructions and is capped at **6,000 characters**. Single descriptions/beats above 1,200 characters must be shortened or split; chapters above 800 crops must be divided. Model accuracy still depends on the metadata and narration; preview the finished timeline before exporting.

Desktop checkpoints are `.editor-stages.en.json`, `.editor-stages.hi.json`, and `.editor-stages.visual.json` in the chapter directory. Phone checkpoints are `stages[.hi].json` and `stages.visual.json` alongside its Editor package. Input hashes and task-prompt fingerprints reject stale responses and rerun only affected work. The two devices keep their checkpoints locally; they do not share partial runs. **Restart matching** keeps the visual index and resets narration matching. Unresolved review never becomes a completed timeline.

## Maintaining the shared planner

`server/src/services/editorWorkflow.ts` is the single task planner used by the server and the phone. The phone executes a bundled copy in a separate offline WebView with networking and file access disabled, no native JavaScript interfaces, and JSON-quoted model replies. It does not execute model-provided code.

After changing the planner, regenerate the phone asset from `server/` and rebuild Sleeper-Cell:

```sh
npm run build:editor-workflow -- '/path/to/Sleeper-cell-main/app/src/main/assets/editor-workflow.js'
```

Bump `WORKFLOW_VERSION` and the Android `EditorStages.VERSION` when changing the input protocol incompatibly. Prompt text is included in each task's checkpoint fingerprint. Tests exercise the bundled planner against the server planner, strict ID/coverage validation, resume, invalidation, size splitting, and semantic repair failures.

The Chapter 4 read-only sizing pilot used its 53 beats and 82 crops. With fixture replies it produced 38 tasks (11 index, 9 route, 9 selection, 9 review), with a largest prompt of 3,283 characters. Routes and repairs can change the task count in a real model run; this pilot verifies data handling and prompt size, not visual matching quality.
