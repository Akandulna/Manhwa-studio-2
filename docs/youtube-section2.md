# YouTube section 2: manual titles

Scope: English titles shared across all parts of a series. Manual ChatGPT workflow only. Description generation, thumbnail generation, and Sleeper-Cell dispatch are later sections.

## User workflow
1. Open a series in YouTube.
2. Create a title prompt, then copy the complete prompt to ChatGPT with web search available.
3. Paste the returned JSON into Studio and import five titles.
4. Select a suggestion or enter a custom title; copy the saved selection when needed.
5. Suggest five more to prepare a new prompt that excludes all previous suggestions and selected custom titles. Earlier suggestions remain available.

Custom titles also work before preparing any prompt. Prepared prompts and their import status are selectable from history. Previous title selections can be restored. Reload saved titles refreshes changes from another window without clearing a pasted response.

## Prompt and response contract
The server reads the canonical series name and current active title guideline revision. Each prepared prompt stores a unique request ID, complete prompt, series identity, guideline ID and SHA-256. Updated guidelines apply to newly prepared prompts; existing prompt text remains unchanged.

ChatGPT is instructed to search/read at least two different relevant source sites, prefer a primary synopsis, distinguish adaptations and alternate titles, produce five distinct factual English hooks, and avoid part-specific claims. The complete title must fit 100 characters including suffix. The title document is reference material; its advice does not override the JSON contract.

JSON contains schemaVersion=1, requestId, seriesId, language=en, status=ok, research (resolvedTitle, summary, sources with title/url), and exactly five title strings. Matching needs_input/unavailable responses surface their factual question or missing capability without importing titles. Studio accepts an optional outer JSON code fence. It rejects malformed, mismatched, incomplete, repeated, overlong or unsafe inputs; the batch is imported atomically. Research links are supplied by ChatGPT, not independently checked by Studio. No link is fetched by the import endpoint.

## Persistence and compatibility
Existing section-1 workspaces are upgraded on open with an empty title state while retaining all existing fields and guideline references. Title state includes requests, imported suggestions, selection history and a numeric revision. Mutations require the current revision. A repeated identical import is idempotent; changed replay data is rejected. Different series use isolated storage. Existing descriptions/images remain saved when a chosen title changes and are flagged for future updates.

Runtime data under `.config/youtube/` is ignored by Git. All source changes remain uncommitted.

## Validation
26 focused storage/import/HTTP tests cover both YouTube sections. Client and server TypeScript and the client bundle build are checked. An isolated browser scenario covers copying, malformed and cross-series response rejection, imports, suggested/custom selections, additional batches, duplicate rejection, concurrent edits, reload without losing pasted JSON, persistent history, series isolation and a 1024px layout. Test fixtures are synthetic; no real ChatGPT or phone generation is invoked.
