-- Listings whose source props don't yet match their public props.
-- The backfill is complete when this returns no rows.
SELECT fulfillment_strategy, count(*) AS outstanding
FROM "Listing"
WHERE (
    fulfillment_strategy = 'STOCK'
    AND (
      ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at)
        IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
      OR NOT ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at) IS NULL
    )
  )
  OR (
    fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY')
    AND (
      ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at)
        IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
      OR NOT ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at) IS NULL
    )
  )
GROUP BY fulfillment_strategy;
