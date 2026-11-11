-- Listing source props backfill: read-only inspection.
-- Run in local, dev or staging before trying 02-preview-batch.sql.
-- This file never updates listings. Check the connection identity first.

SELECT current_database() AS database_name,
       current_user AS database_user,
       current_setting('transaction_read_only') AS connection_is_read_only,
       version() AS postgres_version;

-- Keep the inspection read-only and bound expensive counts to 30 seconds.
-- If a statement times out, run ROLLBACK before another script.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

-- The migration copies four public values into one of two sources.
-- STOCK uses stock_*. BUNDLE and STOCK_THEN_ASSEMBLY use assembly_*.
-- The other source must contain NULLs, including its reconciliation date.
-- All eight source columns must therefore already allow NULL.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'Listing'
  AND column_name IN (
    'stock_qty_available', 'stock_qty_on_hand', 'stock_qty_expected', 'stock_reconciled_at',
    'assembly_qty_available', 'assembly_qty_on_hand', 'assembly_qty_expected', 'assembly_reconciled_at'
  )
ORDER BY column_name;

-- This count reads the table. Run once before the pilot and once to verify it,
-- rather than repeating a full-table count after every small batch.
-- IS DISTINCT FROM compares NULLs safely, unlike <>.
-- ROW(...) compares all four values, including the reconciliation date.
SELECT fulfillment_strategy,
       count(*) AS total_listings,
       count(*) FILTER (WHERE
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
       ) AS mismatched_listings,
       count(*) FILTER (
         WHERE fulfillment_strategy NOT IN ('STOCK', 'BUNDLE', 'STOCK_THEN_ASSEMBLY')
       ) AS unsupported_strategy_listings
FROM public."Listing"
GROUP BY fulfillment_strategy
ORDER BY fulfillment_strategy;

-- Check for database triggers that could do more than the UPDATE itself.
-- Foreign-key constraint triggers are excluded. Review any returned triggers
-- before assuming that only the eight source columns will change.
SELECT tgname AS trigger_name, pg_get_triggerdef(oid) AS trigger_definition
FROM pg_trigger
WHERE tgrelid = 'public."Listing"'::regclass AND NOT tgisinternal;

-- Inspect the existing indexes. The batch walks the primary key in ID order.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'Listing';

COMMIT;
