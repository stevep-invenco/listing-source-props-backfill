# Listing source props backfill

SQL scripts that bring every existing Sales Listing's source props into line with its public props. You run them by hand in DataGrip, one batch at a time, in each environment. Tracked in [ENG-7140](https://linear.app/invenco/issue/ENG-7140).

## Quick start

Everything you run is in [scripts/](scripts). Run each file whole, in one DataGrip session connected to the Sales database, starting with no open transaction.

**Before you start**, confirm that [ENG-7122](https://linear.app/invenco/issue/ENG-7122) has deployed to the environment and has been live for at least 15 minutes. Older Sales code can still save Listings without the source props.

1. **Inspect.** Run [scripts/01-inspect.sql](scripts/01-inspect.sql). Check that you're connected to the right database, that all eight source columns are nullable, and that no unexpected triggers exist on `Listing`.
2. **Record the starting point.** Run [scripts/03-verify-progress.sql](scripts/03-verify-progress.sql). Save the `ALL` row.
3. **Preview a batch.** Run [scripts/02-preview-batch.sql](scripts/02-preview-batch.sql) unchanged. It ends with `ROLLBACK`, so nothing is saved. Check `rows_selected` and `rows_updated`, and how long it took.
4. **Commit a batch.** In `02-preview-batch.sql`, set `LIMIT` to the batch size and change the last line from `ROLLBACK;` to `COMMIT;`. Run it.
5. **Repeat step 4** until `rows_selected` comes back as 0. Pause between batches and watch database load and ClickHouse lag.
6. **Confirm completion.** Run `03-verify-progress.sql`. The `ALL` row must show `remaining_listings = 0` and `unsupported_strategy_listings = 0`. Record the result on ENG-7140.
7. **Change the last line back to `ROLLBACK;`** so the next person starts with a preview.

Run `03-verify-progress.sql` once more immediately before [ENG-7131](https://linear.app/invenco/issue/ENG-7131) deploys to the environment.

**If a batch errors**, run `ROLLBACK;` in the same session, then run `03-verify-progress.sql` before trying again. Rerunning is always safe. A batch only touches Listings that still need fixing.

**Start small.** Use 100 for the first committed batches. Increase the batch size only after you've seen how the database and ClickHouse respond. Choose a size and pace in staging before production.

## Background

Each Sales Listing stores public qty props and a reconciliation date that sellers' shops see. The Self-Aliased SKUs project adds two sets of source props beside them:

- Stock props, for stock held under the SKU's own code.
- Assembly props, for stock that can be assembled from the SKU's components.

The fulfilment strategy decides which source is active. The other source is null. Since [ENG-7121](https://linear.app/invenco/issue/ENG-7121) and ENG-7122, every Listing save copies the public values into the active source and writes null to the inactive one. Listings that have not been saved since those releases still hold zero and epoch placeholders.

ENG-7131 later calculates public qty from the source props. That is only safe once no mismatched Listing remains. These scripts fix the remaining Listings.

## What a batch changes

| Listing strategy      | Source copied from stored public values | Source cleared to NULL |
| --------------------- | --------------------------------------- | ---------------------- |
| `STOCK`               | `stock_*`                               | `assembly_*`           |
| `BUNDLE`              | `assembly_*`                            | `stock_*`              |
| `STOCK_THEN_ASSEMBLY` | `assembly_*`                            | `stock_*`              |

A batch assigns the eight source columns only. It leaves the public values, `qty_listed`, `version`, `updated_at` and `refreshed_at` unchanged. It copies the public reconciliation date together with the quantities. It does not read Inventory or recalculate an assembly from its components.

## Why it is safe alongside live Sales traffic

- Nothing reads the source props until ENG-7131 deploys, so a wrong value cannot reach a seller.
- The version is left unchanged. A live save that loaded the Listing before the batch ran still succeeds. That save writes matching source props itself.
- The batch repeats its mismatch check inside the UPDATE. It skips a Listing that a live save corrected after selection.
- It copies from the UPDATE target row, so it never writes back public values captured earlier.
- If an overlap still leaves a Listing mismatched, the verification query counts it and another batch fixes it.

This depends on every running Sales writer already maintaining the source props. That is why the quick start waits for ENG-7122 to be fully live. The longest Sales Lambda timeout is 900 seconds.

## Script details

| File | Writes? | Purpose |
| ---- | ------- | ------- |
| [scripts/01-inspect.sql](scripts/01-inspect.sql) | No | Checks database identity, that all eight source columns allow NULL, strategy counts, triggers and indexes. |
| [scripts/02-preview-batch.sql](scripts/02-preview-batch.sql) | Only with `COMMIT` | Fixes at most `LIMIT` Listings in one transaction. Ends with `ROLLBACK` by default. |
| [scripts/03-verify-progress.sql](scripts/03-verify-progress.sql) | No | Counts total, matching and remaining Listings per strategy, plus an `ALL` row. |

Each script carries comments explaining every statement.

The batch runs at READ COMMITTED with a one-second lock timeout and a 15-second statement timeout. If a live save holds a Listing's row lock for longer than a second, the batch fails rather than waiting.

`rows_updated` can be smaller than `rows_selected` when a live save fixes a selected Listing first. A full batch doesn't tell you how many remain. Use the verification query for that. It reads the whole table, so don't run it after every batch.

To see the query plan, uncomment the `EXPLAIN (ANALYZE, BUFFERS, WAL)` line in `02-preview-batch.sql` and keep the final `ROLLBACK`. Restore the comment afterwards.

Every committed row still produces change traffic for Streamkap and ClickHouse. A rollback preview cannot show that load. Each batch searches for mismatches from the start of ID order, so the search cost grows as the backfill progresses. If it is slow in staging, measure a temporary partial index before production.

## Local evidence

On 2026-11-11, eleven checks passed against a PostgreSQL 16.4 lab database. They used the real `PrismaListingRepo` and mapper from invenco/sales at commit `a173d8f7`, with synthetic rows. The checks cover:

- Rollback previews.
- Source assignments for all three strategies.
- Unchanged public columns, version and timestamps.
- One database update per corrected Listing, and zero updates on a repeat.
- An active NULL source with zero public values and an epoch reconciliation date.
- A Listing whose inactive source alone needs correction.
- The row limit, and verification counts before and after completion.
- A previously loaded live `STOCK` save after the batch commits.
- A live `STOCK` save that commits before the batch starts.
- Both overlapping row-lock orders between the batch and a live repository save.

Removing the batch's second mismatch check makes the live-save-first case fail, because the batch then updates a row the live save already corrected.

A synthetic 100,001-row run with 100 mismatches at the end of ID order took about 25 ms with cached buffers. [local-query-plan.txt](local-query-plan.txt) records the plan. This shows the query shape, not dev, staging or production capacity.

These results cover the tested row-update interleavings against that writer code. They do not verify deployed application versions, production capacity or ClickHouse lag. The stored public values can themselves be stale. The backfill copies them into the source props without repairing Inventory freshness.

### Rerunning the rehearsal

The rehearsal files sit at the repo root:

- [listing-source-props-backfill.test.ts](listing-source-props-backfill.test.ts)
- [jest.config.cjs](jest.config.cjs)
- [run-local-rehearsal.py](run-local-rehearsal.py)

They expect a checkout of invenco/sales at `../../worktrees/sales-eng-7130` relative to this repo, and a local Postgres on port 54320 with a `sales_source_props_lab_20261111` database holding the Sales schema. The harness refuses any other database before deleting fixtures. From the directory two levels above this repo, run:

```sh
python3 work/listing-source-sql/run-local-rehearsal.py
```
