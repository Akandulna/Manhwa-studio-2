# YouTube library: readiness and manual completion

The library no longer displays the global Titles / Descriptions / Thumbnails feature strip. Each series card shows English readiness and a Hinglish “Coming later” placeholder. No Hinglish generation or completion is implied.

English shows Done when a selected title, description and selected thumbnail are saved and neither description nor thumbnail is flagged as needing an update. Other states are Not started, In progress and Needs update. Statuses are read from existing workspace JSON without creating missing workspaces or loading guideline documents.

Each active series has Mark done. This stores closedAt independently of English readiness, removes that series from the active list and places it under Completed series at the bottom. The native details accordion is closed by default. It supports opening the workspace and Reopen, which clears closedAt and restores the active card. Manual completion never deletes generated content or automatically changes readiness. Saving all three English materials does not automatically archive a series; changes made after manual completion do not reopen it automatically.

Batch status requests validate series IDs and are limited to 500 per request. The client batches larger libraries. Completion updates require a boolean and the expected shared workspace revision; stale windows cannot overwrite newer work. Failed saves leave cards in their original list and offer Reload statuses. Search filters active and completed cards, with matching and total completed counts visible on the closed summary. Existing series ordering is retained in both lists.

Validation: 67 focused YouTube tests (including seven library status, persistence, reopening, bounds, legacy and HTTP tests), server/client TypeScript and the web bundle build. Tests use temporary workspaces. Existing user series are not manually marked done during validation.
