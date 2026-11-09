# AntiGravity: local CLI compatibility report

This report records PRD §5.3 evidence for the installed Antigravity CLI. Studio keeps the latest machine-readable report in the Setting `antigravityCompatibility`, and **AntiGravity → Settings → Local Antigravity** shows it. If the CLI version, the selected model or the sandbox setting changes, the saved proof no longer counts until the test runs again.

## 2026-11-07, agy 1.5.2 (live, operator's signed-in account)

| PRD §5.3 item | Result | Evidence |
| --- | --- | --- |
| 1. CLI version and options recognized | ✅ | `~/.local/bin/agy`, `--version` reports 1.5.2. Flags used: `--print`, `--output-format json`, `--model`, `--conversation`, `--settings`, `--sandbox`, `--disable-slash-commands`. |
| 2. Signed-in account runs a bounded turn | ✅ | `agy models` listed 13 models without a sign-in prompt. Every headless turn returned `status: SUCCESS`. |
| 3. Models listed and one requested explicitly | ✅ | `--model gemini-3.8-flash-low`. An unknown ID exits `1` with `status: ERROR` and the list of available models. |
| 4. Isolated workspace loads Studio's MCP server | ✅ | `<temp workspace>/.agents/mcp_config.json` with `{"mcpServers":{"studio":{"command":node,"args":[probe-mcp.mjs,…]}}}`. The global `mcp_config.json` was not touched. |
| 5. MCP tool returns an image the model inspects | ✅ | `fetch_slice` returned `{type:"image", data:<base64 PNG>, mimeType:"image/png"}`. |
| 6. Result depends on image content | ✅ | A fresh random 5-character code plus a shape and colour were drawn into pixels only. The answer key stayed in Studio's memory. Spike run: submitted `NNW6A/triangle/green` = key. Studio's test (sandbox on, conversation `6061b215-…`): all checks passed in 42 s. |
| 7. Completed turn yields a conversation ID | ✅ | `conversation_id` appears in the JSON envelope. It is identical to `_meta["antigravity.google/conversation_id"]` on each MCP `tools/call`. |
| 8. Second turn resumes that exact conversation | ✅ | `--conversation <id>` returned the same ID with `num_turns: 2`. It recalled the image facts with **no** new MCP calls. |
| 9. Denied tools, malformed output, quota, cancellation | ◐ | Done:<br>• **Denied tool:** without the `mcp(studio/*)` allow rule, the turn exits `0` with `status: SUCCESS`, `denied_actions:[…]`, an empty response and a stderr notice. The runner must therefore trust only accepted MCP checkpoints, never the exit code.<br>• **Cancellation and timeout:** these kill only Studio's own process group (unit-tested with a fake CLI).<br>Not yet observed live: quota exhaustion and malformed output. |

**Model identity:** the JSON envelope does not name the served model. Jobs record the *requested* model and `observedModel: "unknown"` (PRD §5.4).

## Findings that shape Phase 4

1. **Image size cap.** The CLI's own changelog (1.5.x) says images the agent views are scaled down to fit:
   - **at most 2000 px per side** for the Gemini path;
   - **2576 px** for Claude models.

   A 2048 px slice would therefore reach Gemini models slightly shrunk (×0.977), and slice-local coordinates would be measured in a scaled space. AntiGravity packages must keep every slice within the selected model's cap. A source wider than the cap must fail visibly, not be resized silently. Before Phase 4 there is one decision to make: slice at 2000 px for this provider, or prove the scaling with a test.
2. **Inherited configuration.** Each job inherits two sources, and this is not neutralized yet:
   - **Plugins.** The CLI has 7 globally installed plugins (`android-cli-plugin`, `chrome-devtools-plugin`, `firebase`, `gdrive`, `google-antigravity-sdk`, `modern-web-guidance-plugin`, `science`), and plugins can contribute MCP tools to every workspace.
   - **Command grants.** The global permission grants contain two `command(…)` allow rules.

   Mitigations:
   - **In place:** jobs allow only `mcp(studio/*)`, and `--sandbox` is on by default. The live test proved that the sandbox does not block Studio's stdio MCP server.
   - **Done (Phase 7):** each attempt's effective tool set is recorded from its own conversation transcript and shown in the run's event log. Anything other than Studio's tools and the CLI reading its own files is flagged **UNEXPECTED** (`toolUse.ts`).
3. **Unapproved tools.** In headless runs these are quietly denied (exit `0`). So "process succeeded" is never evidence of a result (PRD §10.3).

## Live production runs (2026-11-07)

| Model | Compatibility test | Real pages | Notes |
| --- | --- | --- | --- |
| Gemini 3.8 Flash (Low) | ✅ 5/5, 42–46 s | Pilot 1 `page_004`: no result | Fetched all 6 slices, then tried a Python `run_command`. That was refused, which ends the whole turn in print mode. This led to the no-shell instruction and same-conversation continuations. |
| GPT-OSS 120B (Medium) | ❌ image check | — | **Text-only.** It received the MCP image, said it couldn't view it and tried `tesseract`, which was refused. The model picker now labels it "text only". |
| Claude Sonnet 5.5 (Medium) | ✅ | 4 pages (`page_001`–`page_004`), 1 at a time | 84–117 s per page. 1–2 review rounds. No refused actions. All imported and shared with phones. |
| Gemini 4 Argon (Medium) | ✅ | 4 pages (`page_005`–`page_008`), **2 at a time** | 212–454 s per page. 1 review round each. Each page had its own conversation, and pages finished out of order without mixing results. |

**Tool use seen in those transcripts.** Besides Studio's tools, models call `read_file` on two things, and the allow-only rule doesn't block either:
- the CLI's own offloaded copies of the slice images Studio delivered (`brain/<conversation>/.system_generated/steps/N/media_0.webp`);
- its cached Studio tool schemas (`antigravity-cli/mcp/studio/*.json`).

Both are the CLI's own files, and Studio counts them as expected. Any other path is flagged. Tool names appear in two styles (`call_mcp_tool` with `ServerName`/`ToolName`, or `mcp_studio_<tool>`), and both are handled.

## Still not observed live

- Quota exhaustion, a signed-out CLI and model removal. Studio classifies these from the envelope and stderr and pauses the run, but that's tested only with a fake CLI.
- Malformed JSON from a real model. The correction path is unit-tested; real models haven't yet submitted malformed JSON.
