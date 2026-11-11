-- Listing source props backfill: read-only progress and completion check.
-- Run before the first batch and after selected COMMITTED batches in DataGrip.
-- A rolled-back preview makes no lasting progress, so this count will not fall.
-- This checks all accounts and all listings. There is no cursor or row limit.
-- Counting progress reads the table. Do not turn this into frequent polling.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

-- The matching rule is the same rule used by 02-preview-batch.sql:
-- STOCK has matching stock values and a NULL assembly source.
-- BUNDLE and STOCK_THEN_ASSEMBLY have matching assembly values and a NULL stock source.
-- Reconciliation dates are checked alongside all three quantities.
-- Unknown strategies count as remaining work and require investigation.
WITH inspected AS (
  SELECT fulfillment_strategy,
         fulfillment_strategy NOT IN ('STOCK', 'BUNDLE', 'STOCK_THEN_ASSEMBLY') AS unsupported,
         CASE
           WHEN fulfillment_strategy = 'STOCK' THEN
             ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at)
               IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
             OR assembly_qty_available IS NOT NULL OR assembly_qty_on_hand IS NOT NULL
             OR assembly_qty_expected IS NOT NULL OR assembly_reconciled_at IS NOT NULL
           WHEN fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY') THEN
             ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at)
               IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
             OR stock_qty_available IS NOT NULL OR stock_qty_on_hand IS NOT NULL
             OR stock_qty_expected IS NOT NULL OR stock_reconciled_at IS NOT NULL
           ELSE TRUE
         END AS needs_migration
  FROM public."Listing"
)
SELECT statement_timestamp() AS checked_at,
       CASE WHEN grouping(fulfillment_strategy) = 1 THEN 'ALL'
            ELSE fulfillment_strategy::text END AS fulfillment_strategy,
       count(*) AS total_listings,
       count(*) FILTER (WHERE NOT needs_migration) AS matching_listings,
       count(*) FILTER (WHERE needs_migration) AS remaining_listings,
       count(*) FILTER (WHERE unsupported) AS unsupported_strategy_listings,
       CASE WHEN count(*) = 0 THEN 100.00
            ELSE round(100.0 * count(*) FILTER (WHERE NOT needs_migration) / count(*), 2)
       END AS completion_pct
FROM inspected
GROUP BY GROUPING SETS ((fulfillment_strategy), ())
ORDER BY grouping(fulfillment_strategy), fulfillment_strategy;

-- The ALL row is the environment-wide result at checked_at.
-- Complete means remaining_listings = 0 and unsupported_strategy_listings = 0.
-- Percentages are descriptive. Use the exact counts to decide completion.
-- A later old-version writer could make rows mismatch again. Confirm the deployed
-- writer version and drained older invocations before relying on a zero result.
COMMIT;
