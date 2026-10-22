# Who sends requests to the relay

Verified against the sender metadata and transport code on 20 October 2026. Agent names are logical reporting roles inside Studio or Sleeper-Cell, not separate AI services. This diagram shows request paths, not a measured per-agent request breakdown.

```mermaid
flowchart TB
    subgraph MAC["Mac — Manhwa Studio"]
        SA["Studio reporting agents<br/>Manhwa Studio · Issues · Device Fleet<br/>Library & Download · Page Preparation<br/>Narration & Alignment · Image Clipper<br/>Editor & Export · Storage · Accounts"]
        SO["Durable Studio report outbox"]
        LA["Legacy phone receipt adapter"]
        SA --> SO
        LA -->|"Creates legacy-source manager reports"| SO
    end

    subgraph PHONES["Sleeper-Cell — Nord and Note 10 Pro"]
        DEV["Nord / Note 10 Pro"]
        PA["Reporting agents on each phone<br/>Device · Library & Preparation<br/>Narration · Voiceover · Device Image Clipper<br/>Editor · Sync · Website UI Monitor"]
        PO["Durable phone report outbox"]
        PR["Phone relay client<br/>Status, library and progress receipts"]
        DEV --> PA --> PO
        DEV --> PR
    end

    MP["Managed pilot clients<br/>Studio: plan / claim / pause / import<br/>Nord: handshake / inbox / renew / checkpoint / upload"]
    READ["Studio status and verification reads"]

    W["Cloudflare Worker<br/>Authenticates incoming HTTP requests<br/>and WebSocket connections"]
    DO["Relay Durable Object<br/>Daily safety budget + request handlers<br/>Manager reports · receipts · task ownership"]
    DB[("Durable SQLite state<br/>Reports · tasks · checkpoints · counters")]
    ALARM["Relay alarm<br/>Background liveness checks"]

    SO -->|"POST /manager/report"| W
    PO -->|"POST /manager/report"| W
    PR -->|"POST /receipt/{kind}; connect /ws"| W
    MP -->|"Authenticated /managed/* requests"| W
    READ -->|"GET /state, /usage, /managed/*"| W
    W -->|"Forward to main Durable Object"| DO
    ALARM -->|"Internal invocation; no incoming Worker HTTP request"| DO
    DO --> DB
    DO -.->|"Existing desktop WebSocket: phone receipts"| LA
    DO -.->|"Existing phone WebSocket: commands / shared updates"| PR

    classDef sender fill:#e8f1ff,stroke:#3975bc,color:#14283f;
    classDef cloud fill:#fff1d7,stroke:#c28324,color:#49310e;
    classDef local fill:#e8f7ee,stroke:#33815c,color:#183b2b;
    class SA,PA,DEV,MP,READ sender;
    class W,DO,DB,ALARM cloud;
    class SO,PO,PR,LA local;
```

- **Direct manager reporting:** Studio agents → Studio outbox → relay; phone agents → phone outbox → relay.
- **Additional forwarded reports:** phone receipt → relay → Studio's legacy adapter → Studio outbox → relay. Native and legacy sources can describe related work; they are distinguished in the journal. This is an additional path, not proof that every native report is duplicated.
- **Other traffic:** managed pilot commands/checkpoints, status reads, WebSocket connections/reconnections, and internal relay alarms.
- Dotted arrows are pushes over an existing WebSocket, not a new HTTP request for each update. Worker requests, DO invocation events and SQLite row operations are separate metrics.
- Report delivery honors the durable Retry-After pause. Phone reporting health records and Studio health-only reports are throttled; changed observations can send sooner.
- The planned **Cloudflare Manager** and **Automation Manager** currently show not reporting. The relay and managed-pilot clients still generate their own transport traffic.
- Per-agent request counts and a complete per-URL request log are not currently retained. Today's accepted source identities are in [sender evidence](relay-senders-2026-10-20.json); aggregate request metrics are in [today's report](relay-requests-2026-10-20.md).
