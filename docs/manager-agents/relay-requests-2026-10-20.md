# Relay requests — 20 October 2026

Cloudflare analytics window: **00:00–10:30:48 IST** (19 October 18:30 UTC through 20 October 05:00:48 UTC). Worker: `sleeper-cell-relay`.

| Worker metric | Reported count |
|---|---:|
| Requests | 1,943 |
| Errors | 0 |
| Subrequests | 1,943 |

## Worker requests by IST hour

| IST interval | Requests |
|---|---:|
| 00:00–01:00 | 261 |
| 01:00–02:00 | 390 |
| 02:00–03:00 | 275 |
| 03:00–04:00 | 194 |
| 04:00–05:00 | 38 |
| 05:00–06:00 | 60 |
| 06:00–07:00 | 112 |
| 07:00–08:00 | 167 |
| 08:00–09:00 | 125 |
| 09:00–10:00 | 99 |
| 10:00–10:30:48 | 222 |

## Worker execution outcomes

| Outcome | Requests |
|---|---:|
| clientDisconnected | 140 |
| responseStreamDisconnected | 11 |
| success | 1,792 |

## Durable Object invocations

| Type | Requests |
|---|---:|
| alarm | 447 |
| hibernation | 140 |
| http | 1,955 |
| **Total** | **2,542** |

Cloudflare flags 119 DO errors: 102 client-disconnection events and 17 response-stream disconnections. Worker error aggregate is 0. These are different metric datasets; do not add Worker and DO request counts. Platform “success” does not mean HTTP 2xx, so the previously observed safety-budget 429s are not a separately countable category in this dataset.

## Availability of an individual request list

Existing Worker settings: observability is unset, Logpush is false, and no tail consumer is configured. The available Worker analytics dimensions contain time/outcome/script metadata, with no request URL or HTTP status field. A complete historical list of individual request URLs/timestamps or endpoint counts therefore cannot be reconstructed from the available records. The CSV gives every returned minute/outcome aggregate, not one row per request. No logging or deployment configuration was changed.

## Relay counters after the 05:30 IST rollover

At approximately 10:30 IST, the relay-local safety counter reported 1,145 admitted operations, 368,207 row reads and 6,649 row writes. That counter includes handler events, omits some ingress/rejected traffic, and starts at 05:30 IST; it is not the midnight-IST Worker total or account-wide billing.

Data: [minute/outcome CSV](relay-requests-2026-10-20.csv), [full aggregate JSON](relay-requests-2026-10-20.json).
