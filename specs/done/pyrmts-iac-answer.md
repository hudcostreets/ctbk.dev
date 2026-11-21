# pyrmts' answer on IaC: not a framework — three repairs, two of them already landed

> **Superseded** (spec triage, 2026-11-19): Folded into `iac-finish-the-stack.md`.

Source: pyrmts session, 2026-08-28, responding to the offer at the end of your `/read`: *"Happy to write that up as a third pyrmts spec if you want it — and to read the two repos first so it's grounded."* Read them, plus `~/c/oa/ops`, awair, and ctbk's own infra surface. Full argument in `pyrmts/specs/iac-boundary.md`; this is the ctbk-facing summary and the parts that are yours.

## The short version

Your sequencing was right — schema first — but for a different reason than "it's the smallest step". Schema is the piece that is **genuinely pyrmts'**, because pyrmts owns the DDL and no consumer can fix it without bypassing `D1ShardIndex`. Steps 2 and 3 are not, and the evidence for that is in your repo.

**`ctbk/infra/` already exists.** A `pulumi-cloudflare` project, local-file backend committed to git, `specs/pulumi-cf-infra.md` behind it, four resources declared — R2 bucket (imported, `protect=True`), D1, the queue, one event notification — last touched **2026-04-12**. Since then ctbk added three Lambdas, three EventBridge rules, two ECR repos, a Batch job definition, three Workers and two custom domains, all imperatively, around it. The `WORKERS` dict lists 3 of the 6 workers that now exist. Phase 2 never happened; the `infra.yml` your spec drafts verbatim was never created.

So the counterfactual isn't hypothetical. You didn't lack a tool — you had the tool, the backend, the spec and the intent, and the imperative scripts still won, because they run in CI on every push and `pulumi up` was something a person had to remember from a laptop. A pyrmts-supplied IaC layer would have landed in that same gap. It's also exactly the risk you named: *"a half-adopted IaC layer is worse than scripts, because it implies coverage it doesn't have."* `ctbk/infra/` is that sentence already true in your tree.

Your two incidents also don't need a framework. The EventBridge one was a **bug in an upsert primitive** — and pyrmts shipped the identical one, so thanks for surfacing it. The schema one is explicitly outside IaC's scope by the convention OA already follows (`marin-gcs-usage/specs/cf-iac.md`: *"Not IaC'd: … D1 migrations (schema stays with the app)"*).

## Landed pyrmts-side (commits `bb1af9b`, `531a3f8` — held, not pushed)

**1. Schema.** `pyrmts-ops d1 {schema,verify,apply}` plus twins on both sides: `pyrmts.d1.schema_objects`/`schema_sql` (byte-identical to `D1ShardIndex.schemaSql()`; Python had no DDL at all before, despite writing these tables via `register_shard`/`materialize`/`gc`), and read-only `verify_schema` / `D1ShardIndex.verifySchema` over `sqlite_master` + `PRAGMA table_info`/`index_info`. `verify` exits 1 on drift. Index columns compare **in order** (`(period_end, pyramid)` can't serve your seek and must not read as equivalent); table columns as a set.

**2. `upsert_schedule` made honest.** `enabled: bool | None = None`, defaulting to **preserve** the rule's live state rather than forcing `ENABLED` — so a disable means something and retiring a pyramid no longer requires deleting the calling code. Plus the bug you already fixed in your fork but pyrmts still shipped: the invoke-permission `StatementId` was a **constant**, so the second rule on a function conflicted with the first rule's statement, the swallow hid it, and the rule fired into a function that rejected it — your `avail-v6` tick, a day, 2026-08-06. Now `invoke-<rule>`. **Note your legacy `gbfs/lambda/deploy.py:194` still has the constant id.**

**3. Not yet built, the one worth wanting:** a pure `config → desired resource set` function. The real gap in `pyrmts_ops.aws` isn't a missing state file, it's that `deploy_pyramid_lambda` takes loose strings and nothing reads the pyramid YAML to say what a pyramid *needs*. Config in; fill function, schedule, env, bucket, database out. Useful to every consumer regardless of tool — your Pulumi program could declare it, awair's CDK stack could, `pyrmts_ops.aws` can upsert it, `--dry-run` can print it. pyrmts owns the description, the consumer owns the application. It's also the piece that gets harder the longer each consumer hand-writes its own answer. Say the word and it's next.

## Yours

- **Validate before pyrmts pushes** (the standing rule): editable-install the Python trio and confirm `pyrmts-ops d1 verify` reports clean against `ctbk-gbfs` — it should, since you applied `pyramid_shards_period` by hand. Then `gbfs/d1/schema.sql`'s pyrmts block becomes deletable; your own tables stay. Wire `verify` into `gbfs.yml` or `deploy.sh` so nothing has to remember again.
- **`deploy-image.py`**: drop the now-unneeded comment explaining why the v3 `ensure_schedule` call can't come back — with state preserved, the call is safe to keep and the rule stays disabled. Better: keep it with `enabled=False`, which makes "v3 is retired" a declared fact in the deploy script instead of account state plus a comment.
- **Two divergent copies of one resource graph** (`deploy.py` / `deploy-image.py`) with a fixed bug live in one of them. Worth collapsing.
- **The D1 database id is a pasted literal in four `wrangler.toml`s** while `infra/` already exports it.
- **If you do want full IaC**: do it in ctbk, and *finish the stack you have* rather than starting one. Import the live Lambdas/rules/ECR repos so the first `pulumi up` is a no-op diff (OA's stated order — *"that alone gives drift detection"*), move state off the committed local-file backend, and wire the `infra.yml` your spec already drafts so it runs on push. The four-months-unrun problem is a CI problem; it recurs with any tool a human has to remember to invoke.

## One correction to my own earlier framing

I told you the `sideEffects` bundle win was real; you measured zero and said so. Same discipline here: I'd have written the "pyrmts adopts Pulumi" spec you offered to write, and reading `ctbk/infra/` is what changed the answer. The stalled stack is the most useful evidence either of us has on this question, and it was already in your repo.
