# Wi-Fi status and Refresh

1 November 2026. Studio serves a separate paired TLS/WebSocket interface on port 8847. It supports status metadata and read-only Refresh only. Sync, production commands, screenshot images and managed coordination retain Cloudflare; file transfers retain R2.

Open Settings → Cloudflare → Wi-Fi status. Copy the phone device ID from its Manhwa/R2 settings, create a pairing for the reachable Mac address, and paste the private pairing JSON into the phone within five minutes. Enable Master viewing/refresh only for intended viewers. Credentials are device scoped and revocable; pairing does not share cloud or R2 credentials. Keep generated pairing/certificate state in the ignored local configuration directory.

Local storage acknowledgments are provisional. Phones retain their cloud-pending snapshots; manager outboxes clear only after original cloud acceptance. Ordinary snapshots coalesce toward a 30-second cloud checkpoint. Refresh has a 60-second lifetime and a 50-second local response window, with the original request ID retained for cloud fallback. A target without a reachable local session uses Cloudflare.

The affected suite passed 68 tests; server, client and relay typechecks passed. The compatible production relay revision guard is deployed as `4d71af6f-df37-4cb3-872c-39645981ac03`. Actual cellular fallback was verified on Note10. Its rejoined Wi-Fi currently cannot open a new TCP connection to the Mac; it remains on cloud fallback. Mac sleep/wake, internet loss with a working LAN and representative usage/battery measurement are not yet accepted. A 24-hour relay-local observation is running; no savings percentage is claimed.

The app release keeps Wi-Fi disabled until paired/enabled. Existing production behavior is retained for unpaired clients. See the Android repository's `docs/wifi-status-implementation.md` and `docs/wifi-status-validation.json` for detailed implementation and evidence.
