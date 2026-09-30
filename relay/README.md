# Sleeper-Cell relay

A Cloudflare Worker + Durable Object that carries Sleeper-Cell's status (series downloads, narration scripts,
crop pages) to Manhwa Studio as it happens, and "Refresh from phone" back to the phone, without R2. It keeps
the last copy of each receipt, so Manhwa Studio catches up when it opens even if the Mac was off.
See `src/index.ts` for the protocol.

Runs on the Workers free plan: 100k requests/day; incoming WebSocket messages count 20 to 1; idle sockets
hibernate and cost nothing. The phone sends a receipt only when something changes.

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

## Local testing

```sh
echo 'RELAY_TOKEN=local-test-token' > .dev.vars
npm run dev                          # http://localhost:8787
```
