# Sleeper-Cell relay

A Cloudflare Worker + Durable Object that carries Sleeper-Cell's status (series downloads, narration scripts,
crop pages) to Manhwa Studio as it happens, and "Refresh from phone" back to the phone, without R2. It keeps
the last copy of each receipt, so Manhwa Studio catches up when it opens even if the Mac was off.
See `src/index.ts` for the protocol.

Shared Library catalogs (`library` receipts) go to both desktops and phones. Each origin's last catalog is
stored and replayed when another device reconnects. A catalog first announces the series/chapter listing,
then the prepared R2 ZIP versions; receivers create listings immediately and fetch ready chapters automatically.
Older phone builds ignore this additional receipt kind. Both phones need the updated build for automatic imports.

Production tracker snapshots (`process` receipts) are also stored, broadcast to desktops and other phones,
and replayed on reconnect. Phones report saved chapter stages; the Mac adds alignment, final cropping,
processed timelines and language-specific Editor 2.0 exports, and persists its combined snapshot in R2
under `progress/<Mac device id>.json` for phone catch-up. Parts are fixed at 20 chapters and complete only
when every chapter has both English and Hinglish exports.

Local delivery/reconnect check: run `npx wrangler dev --ip 127.0.0.1 --port 8791 --var RELAY_TOKEN:library-local-check`
and then `node scripts/library-sync-check.mjs` in another terminal. It checks both catalog and process
delivery/replay and writes only to a local relay.

Runs on the Workers free plan: 100k requests/day; incoming WebSocket messages count 20 to 1; idle sockets
hibernate and cost nothing. The phone sends a receipt only when something changes. While a phone is
connected, an alarm wakes the relay once a minute (about 1,440 requests a day) to notice a phone that went
quiet: switched off, out of battery or offline.

## Set up (once)

```sh
cd relay
npm install
npx wrangler login                  # opens the browser; use the account that has the R2 bucket
npx wrangler secret put RELAY_TOKEN # paste the token (Settings → Cloudflare → Phone relay → Generate)
npm run deploy                      # prints https://sleeper-cell-relay.<subdomain>.workers.dev
```

The first deploy may ask you to choose a workers.dev subdomain.

Then:

1. **Manhwa Studio** → Settings → Cloudflare → Phone relay: paste the Worker URL and the same token,
   click **Copy for phone**, then **Save**. The badge turns to "Live".
2. **Sleeper-Cell** → Settings → Manhwa → **Paste R2 settings**: fills in the live relay URL and token.
   Reopen the app; the badge in Manhwa Studio shows "Live · phone open".

## Several phones

Sleeper-Cell can run on more than one phone. Each phone has its own id and a name (Sleeper-Cell → Settings →
Manhwa → Phone name; the model if left blank), and the relay keeps each phone's receipts apart. Manhwa Studio merges
them: its Phone Status page lists every phone, and Start can split a series' chapters between them.

To move from one phone: deploy this relay first (`npm run deploy`), then update Sleeper-Cell on the phones. A phone
that reported before it had an id shows up as "(old app)"; once it runs the new build, its first receipt replaces
those old copies. A phone that's gone can be removed with the bin icon on Phone Status.

## Local testing

```sh
echo 'RELAY_TOKEN=local-test-token' > .dev.vars
npm run dev                          # http://localhost:8787
```

## Free-tier protection

Persistent relay safety budgets, query bounds, client backoff and production validation are documented in [the free-tier budget](../docs/manager-agents/free-tier-budget.md). On-demand counters are available through Studio at `/api/managers/relay-usage`. These counters cover the relay, not account-wide incoming Worker requests.


## Managed task pilot (source only, disabled by default)

Separate Studio/device credentials and the `MANAGED_CROP_PAGE` flag gate the task API; see [Phase 3 configuration and boundaries](../docs/manager-agents/phase3.md). The shared observation token cannot authorize task ownership.

Once a device is durably enrolled, legacy browser run/profile commands are rejected before forwarding, including broadcast commands and cached starts replayed at reconnect. This exclusion survives disabling the managed flag. Sync/receipt and screen observation remain available. Studio browser controls use HTTP to receive admission rather than infer it from a socket send. Reconcile enrolled tasks before rollback; do not remove enrollment/journals to bypass the exclusion. Managed execution and reconciled unenrollment are not yet integrated for rollout.


Managed artifact uploads also require an optional `MANAGED_ARTIFACTS` R2 binding. It is absent from the production config. The adapter verifies actual immutable bytes before staging/publication and reserves at most 256 slots / 64 MB before writes. Use `wrangler.managed-test.jsonc` only with local `wrangler dev` for the artifact harness; it must not be deployed. See [artifact schema, destination validation and remaining rollout blockers](../docs/manager-agents/phase3.md#immutable-artifact-storage-and-studio-validation).
