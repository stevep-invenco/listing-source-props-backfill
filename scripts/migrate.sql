-- Copies public props into the source props selected by the fulfilment strategy
-- and clears the other source. Each UPDATE fixes up to batch_size Listings.
BEGIN;

SET LOCAL backfill.batch_size = '100';

UPDATE "Listing"
SET stock_qty_available = qty_available,
    stock_qty_on_hand = qty_on_hand,
    stock_qty_expected = qty_expected,
    stock_reconciled_at = reconciled_at,
    assembly_qty_available = NULL,
    assembly_qty_on_hand = NULL,
    assembly_qty_expected = NULL,
    assembly_reconciled_at = NULL
WHERE id IN (
  SELECT id
  FROM "Listing"
  WHERE fulfillment_strategy = 'STOCK'
    AND (
      ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at)
        IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
      OR NOT ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at) IS NULL
    )
  LIMIT current_setting('backfill.batch_size')::int
);

UPDATE "Listing"
SET assembly_qty_available = qty_available,
    assembly_qty_on_hand = qty_on_hand,
    assembly_qty_expected = qty_expected,
    assembly_reconciled_at = reconciled_at,
    stock_qty_available = NULL,
    stock_qty_on_hand = NULL,
    stock_qty_expected = NULL,
    stock_reconciled_at = NULL
WHERE id IN (
  SELECT id
  FROM "Listing"
  WHERE fulfillment_strategy IN ('BUNDLE', 'STOCK_THEN_ASSEMBLY')
    AND (
      ROW(assembly_qty_available, assembly_qty_on_hand, assembly_qty_expected, assembly_reconciled_at)
        IS DISTINCT FROM ROW(qty_available, qty_on_hand, qty_expected, reconciled_at)
      OR NOT ROW(stock_qty_available, stock_qty_on_hand, stock_qty_expected, stock_reconciled_at) IS NULL
    )
  LIMIT current_setting('backfill.batch_size')::int
);

COMMIT;
