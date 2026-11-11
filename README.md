# Listing source props backfill

SQL scripts that bring every existing Sales Listing's source props into line with its public props. You run them by hand in DataGrip, connected to the Sales database, in each environment. Tracked in [ENG-7140](https://linear.app/invenco/issue/ENG-7140).

## Background

Each Sales Listing stores public qty props and a reconciliation date that sellers' shops see. The Self-Aliased SKUs project adds two sets of source props beside them:

- Stock props, for stock held under the SKU's own code.
- Assembly props, for stock that can be assembled from the SKU's components.

The fulfilment strategy decides which source is active. The other source is null. Since [ENG-7121](https://linear.app/invenco/issue/ENG-7121) and [ENG-7122](https://linear.app/invenco/issue/ENG-7122), every Listing save copies the public values into the active source and writes null to the inactive one. Listings that have not been saved since those releases still hold zero and epoch placeholders.

[ENG-7131](https://linear.app/invenco/issue/ENG-7131) calculates public qty from the source props, so every Listing must be fixed before it deploys.

| Listing strategy      | Copied from the public props | Set to NULL  |
| --------------------- | ---------------------------- | ------------ |
| `STOCK`               | `stock_*`                    | `assembly_*` |
| `BUNDLE`              | `assembly_*`                 | `stock_*`    |
| `STOCK_THEN_ASSEMBLY` | `assembly_*`                 | `stock_*`    |

The migration changes only those eight source columns.

## Running the backfill

ENG-7122 must have been live in the environment for at least 15 minutes before you start. Older Sales code can still save Listings without the source props.

1. Run [scripts/check.sql](scripts/check.sql). It counts the outstanding Listings for each strategy.
2. Run [scripts/migrate.sql](scripts/migrate.sql). It fixes up to `batch_size` Listings for `STOCK` and up to `batch_size` for the assembly strategies, then commits.
3. Repeat step 2 until `check.sql` returns no rows. Pause between runs and watch database load and ClickHouse lag.
4. Record the final `check.sql` result on ENG-7140.

Run `check.sql` again immediately before ENG-7131 deploys to the environment.

Start with the default `batch_size` of 100, and raise it once you've seen how the database and ClickHouse respond. Choose a size in staging before production. To preview a run, change the final `COMMIT` to `ROLLBACK`.

Running the migration alongside live Sales traffic is safe. Nothing reads the source props until ENG-7131 deploys. A live save writes the same values the migration does. If an error stops a run, roll back and run it again. It only selects Listings that still need fixing.
