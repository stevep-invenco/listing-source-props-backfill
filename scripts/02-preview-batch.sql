-- Listing source props backfill: one manually executed batch.
-- Prototype for local, dev and staging. Production rollout is not approved.
-- Select and execute this ENTIRE file in one DataGrip session.
-- Start with no existing transaction. This file opens its own transaction.
-- It ends with ROLLBACK, so the first execution previews actual UPDATE work.

BEGIN;

-- Use PostgreSQL's usual READ COMMITTED isolation for this transaction.
-- A concurrent update is rechecked against the row that writer committed.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- A live writer might hold a lock on a selected listing. Give up after one
-- second of waiting for a lock, rather than waiting indefinitely.
-- The statement timeout also bounds a slow search for mismatched rows.
-- After any error, run ROLLBACK before trying the file again.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL application_name = 'listing-source-props-backfill-pilot';

-- Find up to the LIMIT below that need correction, in a stable ID order.
-- STOCK uses its stock source. BUNDLE and STOCK_THEN_ASSEMBLY use assembly.
-- The active source must equal the four stored public values.
-- Every column of the inactive source must be NULL.
-- IS DISTINCT FROM compares NULLs safely, unlike <>.
-- ROW(...) compares all four values, including the reconciliation date.
-- MATERIALIZED makes this a fixed selection of IDs for this statement.
-- It does not copy the public values or create a persistent database table.
-- To inspect the actual plan and timing, uncomment EXPLAIN below.
-- EXPLAIN ANALYZE executes the UPDATE. Keep the final ROLLBACK for that rehearsal.
-- The result becomes a query plan instead of the two progress counts.
-- EXPLAIN (ANALYZE, BUFFERS, WAL)
WITH candidates AS MATERIALIZED (
SELECT id
FROM public."Listing"
WHERE
  (fulfillment_strategy = 'STOCK' AND (
    ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at)
      IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
    OR assembly_qty_available IS NOT NULL OR assembly_qty_on_hand IS NOT NULL
    OR assembly_qty_expected IS NOT NULL OR assembly_reconciled_at IS NOT NULL
  ))
  OR (fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') AND (
    ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at)
      IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
    OR stock_qty_available IS NOT NULL OR stock_qty_on_hand IS NOT NULL
    OR stock_qty_expected IS NOT NULL OR stock_reconciled_at IS NOT NULL
  ))
ORDER BY id
-- EDIT THIS NUMBER. One execution selects at most this many rows, then stops.
-- There is no automatic loop or retry. Run the file again yourself.
-- Start with 100 for the pilot. This is a sample, not a measured safe rate.
-- The cap bounds writes. Finding 100 mismatches can still examine many rows.
LIMIT 100
),

-- Copy from the UPDATE target row itself. Do not copy public values into the
-- candidates result and later write those potentially stale values back.
-- A concurrent writer can change a listing between selection and UPDATE.
-- At READ COMMITTED, PostgreSQL rechecks a concurrently updated target row.
-- Repeat the mismatch check here to skip a row a live writer already corrected.
-- The local rehearsal tests both orders with the real repository save path.

-- Only these eight columns are assigned. Public quantities, public dates,
-- qty_listed, version, updated_at and refreshed_at are left unchanged.
-- Keeping version unchanged lets a live writer holding that version still save.
-- This depends on every live writer already maintaining source props correctly.
-- Older application versions must be replaced and drained before a remote write.
-- SQL bypasses domain events, but COMMITTED updates still generate CDC traffic.
updated AS (
  UPDATE public."Listing" AS listing
  SET stock_qty_available = CASE WHEN fulfillment_strategy = 'STOCK' THEN qty_available END,
      stock_qty_on_hand = CASE WHEN fulfillment_strategy = 'STOCK' THEN qty_on_hand END,
      stock_qty_expected = CASE WHEN fulfillment_strategy = 'STOCK' THEN qty_expected END,
      stock_reconciled_at = CASE WHEN fulfillment_strategy = 'STOCK' THEN reconciled_at END,
      assembly_qty_available = CASE WHEN fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') THEN qty_available END,
      assembly_qty_on_hand = CASE WHEN fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') THEN qty_on_hand END,
      assembly_qty_expected = CASE WHEN fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') THEN qty_expected END,
      assembly_reconciled_at = CASE WHEN fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') THEN reconciled_at END
  WHERE listing.id IN (SELECT id FROM candidates)
    AND (
      (fulfillment_strategy = 'STOCK' AND (
        ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at)
          IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
        OR assembly_qty_available IS NOT NULL OR assembly_qty_on_hand IS NOT NULL
        OR assembly_qty_expected IS NOT NULL OR assembly_reconciled_at IS NOT NULL
      ))
      OR (fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') AND (
        ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at)
          IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
        OR stock_qty_available IS NOT NULL OR stock_qty_on_hand IS NOT NULL
        OR stock_qty_expected IS NOT NULL OR stock_reconciled_at IS NOT NULL
      ))
    )
  RETURNING listing.id
)
-- One compact result, not a list of every selected ID.
-- A live save can correct a selected row first, so rows_updated may be smaller
-- than rows_selected. A full batch does not establish how many remain.
-- A partial or empty batch suggests the pass may be finished. Use the full
-- inspection count to confirm completion.
SELECT (SELECT count(*) FROM candidates) AS rows_selected,
       (SELECT count(*) FROM updated) AS rows_updated;

-- DEFAULT: discard this batch. rows_updated describes work inside this
-- transaction, not persisted changes. Running a preview twice repeats that work.
-- For an approved local/dev/staging write, replace the final ROLLBACK with COMMIT.
-- After a commit, corrected rows no longer match, so another execution selects
-- remaining mismatches. There is no cursor to advance or progress table to manage.
-- A preview still performs writes and takes locks before undoing them. It is
-- useful for correctness and timing, but does not rehearse committed CDC load.
ROLLBACK;
