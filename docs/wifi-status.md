# Wi-Fi status and Refresh

1 November 2026. Studio provides a paired TLS/WebSocket interface on port 8847 for status metadata and read-only Refresh. Sync, every other command, screenshot images and managed coordination retain Cloudflare. Files retain R2.

Open Settings → Cloudflare → Wi-Fi status. Copy the intended app install's device ID from its Manhwa/R2 settings, create a pairing with the reachable Mac address, and paste the private JSON into the phone within five minutes. Enable Master viewing/refresh only for intended viewers. Pairing does not share cloud or R2 credentials. Generated credentials, certificate keys and local state remain ignored. Production and beta installs need separate pairings.

A local storage acknowledgment never releases cloud-pending phone data or a manager outbox. Phones remain the sole writers of mutable cloud snapshots. Studio displays manager observations provisionally and can forward original bounded batches, retaining original cloud acceptance semantics. Ordinary changed snapshots coalesce toward a 30-second cloud checkpoint. Native v1.0.212 additionally avoids cloud copies of already confirmed local Refresh state while preserving all explicit cloud answers.

Refresh has a 60-second lifetime and a 50-second local response window. Each target retains its original request ID for fallback. Unsupported commands cannot enter the local interface. Revocation or service disablement restores cloud routing without deleting phone pending data. Reconnection can be delayed by network convergence/backoff.

## Release and evidence

[Android production v1.0.212](https://github.com/Akandulna/Sleeper-Cell-Releases/releases/tag/v1.0.212) was built and published by GitHub Actions. Its source tag, APK checksum, production identity and signature were verified. No production APK was built or installed locally. Pairing remains opt-in.

The compatible relay guard is deployed as `4d71af6f-df37-4cb3-872c-39645981ac03`, preserving the exact prior production bundle's managed/YouTube behavior, storage namespace, R2/secret bindings and observability. Source changes are committed at `0157421`. The affected suite passed 68 tests, and server/client/relay typechecks passed. Android's isolated release suites each passed 937 tests; the combined beta suites each passed 968.

Installed checks verified cellular cloud fallback, actual Mac sleep/wake recovery and two-phone local Refresh. Corrected beta 1.0.217 was installed and hash-verified on Note10. Its unchanged local metadata avoided cloud uploads; explicit Cloudflare Refresh still delivered all three original-ID answers. During a temporary synthetic cloud safety pause, native Master Refresh completed locally and dirty screen state stayed pending until the original pause was restored, then drained.

Nord's corrected-beta installation awaits a usable connection. A physical WAN outage was not tested because the user cannot access the router uplink. A 24-hour account Worker/DO/SQL/R2 and relay-local observation is running through 00:47 IST on 2 November. No general savings percentage or battery-drain improvement is established; the observed phone is USB powered.

See the Android repository's `docs/wifi-status-implementation.md` and `docs/wifi-status-validation.json` for full records.
