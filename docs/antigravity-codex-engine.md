# AntiGravity: ChatGPT (Codex) engine

AntiGravity can process pages with either of two local CLIs:

| Engine | CLI | Sign-in | Usage counts against |
|---|---|---|---|
| Antigravity | `agy` | Google, in `agy` | Antigravity quota |
| ChatGPT (Codex) | `codex` (ships inside ChatGPT.app) | ChatGPT, in `codex login` | The ChatGPT plan's Codex limits (Plus and above) |

Everything else is shared: slicing, Google Drive inputs, Studio's MCP bridge (`server/resources/antigravity/job-mcp.mjs`), the prompt pack, the review rounds, the strict JSON validation, the Clipper import, R2 phone sharing, Reject, Retry and Review again.

## Operator steps

1. Open **Settings → AntiGravity → ChatGPT (Codex)**. The card finds the Codex CLI on PATH, or falls back to `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.
2. If it says you are not signed in, click **Sign in with ChatGPT**. This runs `codex login` in Terminal.
3. Choose a model and a reasoning level. Only models with image input can be chosen.
4. Click **Run compatibility test**. It takes about 20 seconds and uses a little of your Codex limit.
5. In **AI engine**, choose **ChatGPT (Codex)**. New runs use that engine, and every run keeps the engine it started with.
6. Start as usual from a part's Image Clipper. The screen shows the engine and model before you start.

The card also shows the plan's 5-hour and weekly usage windows, taken from Codex's own session records (no network call). If a run hits the usage limit, it pauses. Resume it once the window resets.

## Several ChatGPT accounts

The **ChatGPT accounts** list in the Codex card lets runs carry on when one account's Codex usage runs out.

- **The built-in account** is the Mac's `~/.codex`, which the ChatGPT app signs in. It can be turned off but not removed.
- **Add account** gives each extra account its own Codex folder, `~/Library/Application Support/Manhwa Studio/codex-accounts/<id>`. Studio then opens Terminal with `CODEX_HOME=<folder> codex login`. If the browser opens the wrong ChatGPT account, paste the login link from Terminal into a private window. Removing an account deletes that folder, which holds its sign-in and threads.
- **Order:** Studio uses accounts from top to bottom, and each page stays on the account it started on (`AntigravityAttempt.codexAccount`). A thread is stored in that account's folder, so Review again resumes it there.
- **When an account runs out:** if Codex reports the usage limit or a lost sign-in, the account is kept off until the exhausted window resets (from its session record, or 1 hour if unknown). The page goes back to the queue and restarts its analysis on the next account. The run pauses only when no account is left, or right away if **Switch automatically** is off.
- **Use again** clears an account's limit early. **Use** turns an account on or off.
- **Same account twice:** if two entries are signed into the same ChatGPT account (matched by Codex's opaque account id in session records), the list warns about it.

## How a Codex turn runs

`server/src/services/antigravity/codexCli.ts` builds each turn:

- `codex exec --json` for analysis. Review rounds use `codex exec resume <thread_id>`, which resumes exactly that thread and never uses `--last`.
- `--ignore-user-config --ignore-rules`: the operator's `~/.codex/config.toml` (plugins, computer use, browser, Chrome) is not loaded. Auth still comes from `CODEX_HOME`.
- `sandbox_mode="read-only"`, `approval_policy="never"` and `web_search="disabled"`. Codex features for shell, unified exec, multi-agent, apps, plugins, browser, computer use, image generation, goals, hooks and memories are switched off.
- Only Studio's MCP server is configured, with `default_tools_approval_mode="approve"`. Without this, Codex refuses MCP calls under `approval_policy=never`; that was observed live.
- The capability token is written to `<attempt>/capability.token` (mode 0600). Only that file's path appears on the command line, as `STUDIO_ATTEMPT_TOKEN_FILE`; the token itself never does.

Evidence for each attempt comes from `$CODEX_HOME/sessions/**/rollout-*-<thread>.jsonl` (`codexSession.ts`):

- **Tool use.** Models call Studio's tools from Codex's code-mode `exec` wrapper. These are recorded as "code-mode wrapper"; anything that isn't a Studio tool is recorded as UNEXPECTED.
- **Session model.** Stored as the attempt's `observedModel`.
- **Usage windows.** The plan's 5-hour and weekly Codex limits.

## Data

The `engine` column was added to `AntigravityRun` and `AntigravityAttempt` (default `antigravity`; additive `db push`, backup `prisma/dev.db.pre-codex-engine-20261108-011816.bak`). Settings live in the Setting keys `antigravityCodexSettings`, `antigravityCodexCompatibility` and `antigravityCodexAccounts`; `AntigravityAttempt.codexAccount` was added (backup `prisma/dev.db.pre-codex-accounts-20261108-015709.bak`), and the engine choice in `antigravitySettings.engine`. Parallel pages and the page deadline are shared by both engines.

## Verification (2026-11-08)

- **Live compatibility test:** passed through Studio's API in 17 s. Setup: codex-cli 0.166.0-alpha.5.1, gpt-6.1-sol at medium effort, Plus plan. All five checks passed and the session model was recorded as gpt-6.1-sol.
- **Mocked end to end:** `jobs.integration.test.ts` drives the Codex engine with `fixtures/fake-codex.mjs`. It covers the import, R2 publish, review in the same thread, the lockdown flags, the token kept off the command line, the session evidence, and a usage-limit pause, and failover from a limited account to the next one. Unit tests are in `codex.test.ts`.
- **Not yet run:** a live pilot on a real manhwa page with Codex. It needs the operator to start it, because it uploads to Drive, imports into Clipper and publishes to phones. Watch how well Codex reads 2000 px slices. Codex may downscale images, so check measurement accuracy on a seam-crossing page.
- Codex threads made by Studio are saved like any `codex exec` session, so they may appear in the ChatGPT app's Codex history.
