# Listing source props backfill

SQL scripts that bring every existing Sales Listing's source props into line with its public props. They are run by hand, one batch at a time, in each environment. Tracked in [ENG-7140](https://linear.app/invenco/issue/ENG-7140).

## Background

Each Sales Listing stores public qty props and a reconciliation date that sellers' shops see. The Self-Aliased SKUs project adds two sets of source props beside them:

- Stock props, for stock held under the SKU's own code.
- Assembly props, for stock that can be assembled from the SKU's components.

The fulfilment strategy decides which source is active. The other source is null. Since [ENG-7121](https://linear.app/invenco/issue/ENG-7121) and [ENG-7122](https://linear.app/invenco/issue/ENG-7122), every Listing save copies the public values into the active source and writes null to the inactive one. Listings that have not been saved since those releases still hold zero and epoch placeholders.

[ENG-7131](https://linear.app/invenco/issue/ENG-7131) later calculates public qty from the source props. That is only safe once no mismatched Listing remains. These scripts fix the remaining Listings.

## What the batch changes

| Listing strategy      | Source copied from stored public values | Source cleared to NULL |
| --------------------- | --------------------------------------- | ---------------------- |
| `STOCK`               | `stock_*`                               | `assembly_*`           |
| `BUNDLE`              | `assembly_*`                            | `stock_*`              |
| `STOCK_THEN_ASSEMBLY` | `assembly_*`                            | `stock_*`              |

The update assigns the eight source columns only. It leaves the public values, `qty_listed`, `version`, `updated_at` and `refreshed_at` unchanged. It copies the public reconciliation date together with the quantities. It does not read Inventory or recalculate an assembly from its components.

## Why it is safe alongside live Sales traffic

- Nothing reads the source props until ENG-7131 deploys, so a wrong value cannot reach a seller.
- The version is left unchanged. A live save that loaded the Listing before the batch ran still succeeds, and it writes matching source props itself.
- The batch repeats its mismatch check inside the UPDATE. It skips a Listing that a live save corrected after selection.
- It copies from the UPDATE target row, so it never writes back public values captured earlier.
- If an overlap still leaves a Listing mismatched, the verification query counts it and another batch fixes it.

This depends on every running Sales writer already maintaining the source props. Confirm that ENG-7122 has deployed to the environment and older Lambda invocations have drained before a committed batch. The longest Sales Lambda timeout is 900 seconds.

## Files

| File | Purpose |
| ---- | ------- |
| [01-inspect.sql](01-inspect.sql) | Read-only. Checks database identity, that all eight source columns allow NULL, strategy counts, triggers and indexes. |
| [02-preview-batch.sql](02-preview-batch.sql) | Updates at most `LIMIT` Listings in one transaction. Ends with `ROLLBACK` by default. |
| [03-verify-progress.sql](03-verify-progress.sql) | Read-only. Counts total, matching and remaining Listings per strategy, plus an `ALL` row. |
| [listing-source-props-backfill.test.ts](listing-source-props-backfill.test.ts) | The local rehearsal described under Local evidence. |
| [local-query-plan.txt](local-query-plan.txt) | The query plan from a synthetic 100,001-row local run. |

Each SQL file carries comments explaining every statement.

## Running the scripts in DataGrip

Execute each complete file in one session, starting with no open transaction.

1. Run `01-inspect.sql`. Stop if a source column is missing or required, an unsupported strategy exists, or a trigger could change the update's effect.
2. Run `03-verify-progress.sql` and save the starting counts with their `checked_at` timestamp.
3. Run `02-preview-batch.sql` with its final `ROLLBACK` in place. `rows_selected` counts candidate Listings. `rows_updated` counts updates inside the transaction, which the rollback discards.
4. To inspect the plan, uncomment the `EXPLAIN (ANALYZE, BUFFERS, WAL)` line and keep the rollback. Restore the comment afterwards.
5. For a real write, change only the final `ROLLBACK;` to `COMMIT;`. Choose the limit, run the whole file and check the result. Allow time to watch database load and ClickHouse lag before the next batch.
6. Run `03-verify-progress.sql` after selected committed batches. Completion requires `remaining_listings = 0` and `unsupported_strategy_listings = 0` in the `ALL` row. Use the exact counts, because the percentage can round to 100 before the count reaches zero.
7. Run `03-verify-progress.sql` again immediately before ENG-7131 deploys to that environment. A writer that does not maintain the source props could have recreated mismatches.

The batch runs at READ COMMITTED with a one-second lock timeout and a 15-second statement timeout. After an error, run `ROLLBACK` before retrying. Check a cancelled or failed batch with the verification file before another write.

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

A synthetic 100,001-row run with 100 mismatches at the end of ID order took about 25 ms with cached buffers. This shows the query shape, not dev, staging or production capacity.

The rehearsal ran from a workspace where a checkout of invenco/sales sat at `../../worktrees/sales-eng-7130` relative to these files. `run-local-rehearsal.py` and `jest.config.cjs` expect that layout and a local Postgres on port 54320. The harness refuses any database other than the dedicated lab database before deleting fixtures.

These results cover the tested row-update interleavings against that writer code. They do not verify deployed application versions, production capacity or ClickHouse lag. The stored public values can themselves be stale. The backfill copies them into the source props without repairing Inventory freshness.
