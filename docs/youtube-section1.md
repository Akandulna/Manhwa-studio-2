# YouTube section 1: workspace and guidelines

Scope: Studio only. English, one workspace per series, shared across all parts. Generation, reference selection, and Sleeper-Cell dispatch are later sections.

- Navigation: YouTube after Editor. `/youtube` lists the same visible series as the library; `/youtube/series/:seriesId` opens its persistent workspace.
- Settings: `/settings?tab=youtube` previews and replaces title/thumbnail guidelines and edits description instructions. Each control saves independently of general Settings.
- Imports: selectable-text PDF, UTF-8 TXT/Markdown, and title-report JSON exports (including the supplied extensionless report). Maximum 10 MB and 500,000 extracted characters. Scanned PDFs require a text version; no OCR is implied.
- Defaults: `server/resources/youtube/`. The thumbnail master prompt is an internal source template, absent from settings and public guideline endpoints. Its original one-image production workflow can be adapted for three independent variation requests in the thumbnail section.
- Storage: `server/.config/youtube/` when launched from `server/`, matching Studio's normal working directory. No Prisma migration. General Settings reset does not touch it.
- Each revision retains source bytes, extracted text, timestamp and SHA-256. Active revisions use an atomic index update. Uploads require the expected current revision; conflicting updates return 409. Invalid uploads leave the active document unchanged. Keep this directory with local Studio backups.
- Workspaces retain their creation-time guideline version references. Later generation sections must snapshot the active guideline revisions onto each generation result, preserve earlier results, and validate request/series identity before accepting returned work.
- Runtime: PDF extraction uses `pdf-parse` 2.4.5 (Node >=20.16 <21 or >=22.3; current workstation uses Node 24). Do not invoke ChatGPT or send production phone work from section 1.

Validation: server and client TypeScript, client bundle build, 12 focused storage/import/HTTP tests, isolated browser checks of navigation/search/workspaces, guideline replacement/history, invalid-PDF rejection and description persistence.
