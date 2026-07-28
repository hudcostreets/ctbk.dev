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
- Registry writes from the affected Lambda were stranded in the divergent copy (~190 rows repeatedly re-registered by an in-function reconcile, all into the wrong store); an external (laptop-side) reconcile kept the true store current every 15 min until a Worker-cron reconcile replaced it (below).
- A registry-driven GC was disabled for the duration. The precise hazard is an asymmetry the split creates: object deletion is **global** (R2 is one store) but row deletion is **per-instance** — a GC run whose registry view is the divergent instance deletes the R2 object plus *that instance's* row, leaving the true registry with a dangling registration that serves 404s indefinitely (the reconcile won't re-register a key outside the expected cover — that's why GC chose it). Late GC is harmless (storage cost only); split-view GC is not.
- **Durable fix — self-healing reconcile in the Worker cron** (`gbfs/api` `scheduled()`, every minute): registers any expected-min-cover shard that exists on R2 (HEAD-verified) but is missing from `pyramid_shards`. Shard *objects* are the source of truth and R2 never forked, so this closes the loop entirely inside Cloudflare with no external driver — and permanently closes the write-then-die registration window too. Verified: a tick's stranded tip row landed in the true store ≤1 min after registration.
  - Cron executions are themselves colo-variable: fork-side runs see the fork's stale registry and harmlessly back-fill the *fork* (observed: 186/180 avail-v3 rows "re-registered" that truth already had — insert-only, truth untouched). Truth-side runs do the real work. The recurring bulk-strand log lines double as a live fork indicator; when they stop, the split has healed.
- The Lambda's registrations were also re-routed through a narrow authenticated Worker endpoint (D1 *binding* write path) — which proved the fork is below the API surface (see the colo update below) but does not dodge it; the cron reconcile is what guarantees truth convergence.

## Update (~20:20 UTC): the split is entry-colo-dependent, not REST-specific

We deployed a workaround routing the Lambda's registrations through **our own Worker's D1 *binding*** (narrow authenticated endpoint). Result:

- Laptop → Worker `/api/registry` → binding write: **lands**, visible to laptop REST + wrangler + binding reads (round-trip verified, `registered: 1`).
- Lambda → same Worker endpoint, same secret (explicit `via proxy` branch logging): HTTP 200, `registered: 1` — row **absent** from the majority view (e.g. `avail-v5/1m/5min/2026-07-28T20-10.parquet`, 20:16:47 UTC).

Since the Worker executes at the **caller's entry colo**, this rules out the REST API as the faulty layer: requests entering Cloudflare from the Lambda's egress path (AWS us-east-1) reach a **divergent D1 Durable Object instance even through the Workers binding**, while requests entering from our EWR-adjacent path reach the true instance. i.e. two live instances of one D1 database, selected by network entry point, both acking writes durably. This supersedes the "REST split-brain" framing in the title — it's a D1 DO-layer split.

## Update (~20:35 UTC): selector is narrower than "AWS us-east-1 entry"

Third vantage point: an EC2 instance in **the same region as the affected Lambda** (us-east-1) ran the identical REST probe. Result: **it sees the true state** — row count and tip rows byte-identical to the laptop view, `served_by: v3-prod ENAM ORD`. So region-of-entry alone does not select the divergent instance; the distinguishing attribute is something narrower about the Lambda's egress path (specific egress IP prefix / ASN sub-block / anycast route to a particular CF PoP).

Same window, clean fresh-write probe (checked seconds after registration, before any external reconcile could mask it): Lambda `via proxy` registration of `avail-v5/1m/5min/2026-07-28T20-30.parquet` → **absent from the true view**. The split remained active.

Also noted: the laptop's REST `served_by_colo` moved **EWR → ORD** during this window with no state divergence — so DO re-homing/colo drift is happening live without healing the Lambda-path fork.

Forensics added: the Worker registry endpoint now logs `request.cf.colo`, `CF-Connecting-IP`, and ASN for each proxied registration, plus the D1 binding's own query `meta` — to name the entry colo whose binding requests reach the divergent instance.

## Update (~20:45 UTC): divergent entry colo is IAD — same Worker, same binding, forked by entry colo

`wrangler tail` across a tick (~20:41–20:43 UTC), all requests hitting the **identical Worker route + D1 binding** (`POST /api/registry`):

| entry colo | client | egress IP / ASN | `existing_keys` count | fresh IAD-registered key visible? |
|---|---|---|---|---|
| **IAD** | Lambda (us-east-1) | 98.92.67.143 / AS14618 (Amazon NoVA) | **329 → 330** (its own `register` of `…T20-40.parquet` immediately readable) | in its own view, yes |
| **EWR** | laptop, ~2 min later | 207.251.102.109 / AS8002 | **322**, `served_by: v3-prod`, colo ORD, `served_by_primary: true` | **no** |

Same code path, same database UUID, divergent row sets, keyed purely on `request.cf.colo` of the caller — the Worker at IAD resolves the D1 Durable Object to a different (stale-then-divergent) instance than the Worker at EWR. Note the EC2 probe above egressed from us-east-1 as well but used the REST API (`api.cloudflare.com` anycast) and reached truth — so even within "requests originating in AWS us-east-1," the fork tracks which CF PoP the specific route lands on, and IAD's Workers-binding path is the affected one.

**Both sides claim to be the same primary.** The divergent (IAD-entry) requests' D1 result `meta`, captured ~20:51–20:53 UTC:

```
served_by: "v3-prod", served_by_region: "ENAM", served_by_colo: "ORD",
served_by_primary: true, size_after: 876544 — with 330 rows returned,
and a register of avail-v5/1m/5min/2026-07-28T20-50.parquet acked
(changes: 1, rows_written: 1)
```

The truthful (EWR-entry) requests' meta, same window: `served_by: "v3-prod"`, colo `ORD`, `served_by_primary: true`, `size_after: 876544` — with **322** rows, and the IAD-acked key absent. Identical backend labels, identical reported DB size, divergent contents, both self-identifying as the ORD primary. This is not a mislabeled read replica: Cloudflare's own response metadata asserts primary on both sides of the fork.

## Correlation IDs

Truth-side samples (laptop REST, ~22:05 UTC 2026-07-28, both returning the majority view, `served_by_colo: ORD`):

- `cf-ray: a227b83e7f3d18ad-EWR`
- `cf-ray: a227b83ffaa8ffd0-EWR`

Divergent-side events for edge-log correlation (Workers-binding path via `ctbk-gbfs-api.ryan-0dc.workers.dev`, entry colo **IAD**, client IP `98.92.67.143`, AS14618):

- ~20:41–20:43 UTC: 4× `POST /api/registry` `op=existing_keys` returning **330** rows (majority view: 322) + 1× `op=register` of `avail-v5/1m/5min/2026-07-28T20-40.parquet` acked (`rows_written: 1`) into the divergent copy — its `meta` claiming `served_by: v3-prod / ORD / served_by_primary: true`.
- 20:16:47 and 20:26:34 UTC: registers of `avail-v5/1m/5min/2026-07-28T20-10.parquet` / `…T20-20.parquet`, HTTP 200, absent from the majority view.

(We no longer generate divergent-side traffic: the affected Lambda's registry client was removed entirely — see below — so fresh IAD-side rays would require temporarily restoring a probe. Happy to on request.)

## Resolution on our side: registrations are now single-writer + fully derived

Beyond containment, the design was changed so the split can no longer affect correctness: the Lambda no longer writes the registry **at all** (pure R2 compute node — no D1 client, no CF API token on the write path). The Worker cron is the sole registrar, deriving rows as `expected-min-cover ∩ exists-on-R2 − registered` every minute. Since the registry is now a pure function of R2 state (which never forked), **any** D1 instance converges to the same derived content within ~1–2 min of the cron reaching it — a reader landing on either side of a split sees correct (at worst ≤2-min-stale) covers. The remaining exposure is CF-internal only: which instance survives, and whether acked writes to the discarded one matter to other customers.

## Open questions for Cloudflare

1. What backend does `served_by: v3-prod` name, and can two of them durably hold divergent states for one database uuid?
2. What request attribute pins some clients' REST traffic to the divergent instance (source IP/ASN affinity? gateway shard)? The affected traffic originated from AWS us-east-1 egress IPs.
3. Is the divergent copy's data recoverable/merged on resolution, or discarded? (We have no data loss either way — everything was re-written externally — but silent-ack-then-discard would matter to other customers.)
