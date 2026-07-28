# Cloudflare D1 REST split-brain — 2026-07-28

**Summary**: from ~12:40 UTC on 2026-07-28, D1 REST API requests (`POST /client/v4/accounts/{acct}/d1/database/{db}/query`) originating from an AWS Lambda (us-east-1) operated on a **divergent copy** of database `ctbk-gbfs` — writes durable and immediately readable *from that context*, but invisible to every other client (laptop REST, `wrangler d1 execute --remote`, and the Workers D1 *binding*, which all agreed with each other throughout). Reads from the affected context likewise stopped reflecting external writes. The behavior wobbled per invocation (occasional healthy requests), survived function container recycles and even full function delete/recreate, and was still active ~7 h after onset.

- **Database**: `ctbk-gbfs`, uuid `d5746734-70ba-46aa-8780-be09e4837f0b`
- **Account**: `0dcad5654e9744de6616f74b8df4af63`
- **Affected client**: AWS Lambda `ctbk-avail-cascade-v5` (us-east-1), stdlib `urllib` POSTs to the D1 REST `/query` endpoint
- **Healthy clients, same second, same credentials**: sibling Lambda `ctbk-avail-cascade` (same account/token/code), laptop REST, wrangler, Workers binding
- **CF status page**: no relevant unresolved incident listed at the time

## Decisive probe (2026-07-28 ~19:08 UTC)

One row, PK `(pyramid='avail-v5', tier='1m', shard_dur='2d', period_start=2026-04-07)`, key `avail-v5/1m/2d/2026-04-07.parquet`:

1. In-Lambda: `INSERT OR REPLACE … written_at=1785265708507` → same-invocation `SELECT` **returns the fresh row** (CloudWatch `/aws/lambda/ctbk-avail-cascade-v5`, 19:08:53 `reconcile: read-back …`).
2. Laptop REST, seconds later (t+0/5/10 s): `SELECT written_at …` → **`1784407112764`** (a row written ~10 days prior) — three times.

Both requests: identical URL (same account id + db uuid), identical bearer token (sha-verified), identical SQL shape. The pre-existing row's survival also proves the Lambda's `INSERT OR REPLACE` did not execute against the store other clients see (same PK ⇒ it would have replaced it).

Repeat observations with distinct `written_at` values: 17:16:41 (`1785259000987`), 17:23:28 (`1785259408282`), 17:33 / 17:38 / 17:43 / 18:03 (wobbling stranded-set sizes 169–199), 19:38 / 19:44 (188 each, *after* full function delete+recreate).

## Ruled out

- **Credentials/target**: account id and API token byte-identical between contexts (sha256-compared); no `D1_DATABASE_ID` override anywhere; db uuid appears exactly once in the account's database list.
- **Read replication**: `read_replication.mode: disabled`; query meta shows `served_by_primary: true` (`served_by: v3-prod`, region ENAM, colos ORD/EWR observed).
- **Schema effects**: `PRIMARY KEY (pyramid, tier, shard_dur, period_start) WITHOUT ROWID`; no triggers or unexpected indexes (`sqlite_master` dumped).
- **Client code**: old (hand-rolled urllib) and new (equivalent library) clients byte-equivalent in URL/body/error handling; both check `success: true` and raise otherwise — **the divergent writes return HTTP 200 + success**, so no client-side check can detect them.
- **Container/function identity**: recycles (env-bump) and full delete+recreate of the function did not durably fix routing (one healthy invocation post-recreate at 19:34 — its writes externally visible — then forked again at 19:38).

## Onset bracketing

- ≤12:31 UTC: Lambda-written rows (12:05–12:31 activity) visible externally ✓.
- ≥13:52 UTC: Lambda-context reads missing ~165 rows that external clients see; Lambda writes no longer visible externally.

## Impact & remediation

- No serving impact: the read path uses the Workers **binding**, which stayed consistent with the majority view throughout.
- Registry writes from the affected Lambda were stranded in the divergent copy (~190 rows repeatedly re-registered by an in-function reconcile, all into the wrong store); an external (laptop-side) reconcile kept the true store current every 15 min.
- A registry-driven GC was disabled for the duration (deletions decided from a divergent row view could destroy real objects).
- **Durable fix**: shard registrations re-routed through a narrow authenticated endpoint on our Worker, writing D1 via the *binding* — immune to REST routing. REST is no longer on the Lambda write path.

## Open questions for Cloudflare

1. What backend does `served_by: v3-prod` name, and can two of them durably hold divergent states for one database uuid?
2. What request attribute pins some clients' REST traffic to the divergent instance (source IP/ASN affinity? gateway shard)? The affected traffic originated from AWS us-east-1 egress IPs.
3. Is the divergent copy's data recoverable/merged on resolution, or discarded? (We have no data loss either way — everything was re-written externally — but silent-ack-then-discard would matter to other customers.)
