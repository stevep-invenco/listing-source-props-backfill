import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BasicPrismaClientProvider } from "@invenco/prisma-core";
import { PrismaClient } from "@prisma/client";
import { FulfillmentStrategy } from "@invenco/products-interface";
import { PrismaListingRepo } from "../../worktrees/sales-eng-7130/projects/sales-service/src/modules/sales/repos/impl/PrismaListingRepo";
import { PrismaListingMapper } from "../../worktrees/sales-eng-7130/projects/sales-service/src/modules/sales/repos/impl/mappers/PrismaListingMapper";
import { PrismaChannelMapper } from "../../worktrees/sales-eng-7130/projects/sales-service/src/modules/sales/repos/impl/mappers/PrismaChannelMapper";
import {
  mockChannel,
  mockListing,
} from "../../worktrees/sales-eng-7130/projects/sales-service/src/shared/test/mocks";

describe("Listing source SQL backfill local rehearsal", () => {
  const database = "sales_source_props_lab_20261111";
  const url = new URL(process.env.SQL_LAB_DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "54320" ||
    url.pathname !== `/${database}`
  ) {
    throw new Error(
      "The rehearsal can only use the dedicated local lab database",
    );
  }
  const provider = new BasicPrismaClientProvider(PrismaClient, url.toString());
  const observerProvider = new BasicPrismaClientProvider(
    PrismaClient,
    url.toString(),
  );
  const finalizer = { finalize: jest.fn(async () => undefined) };
  const repo = new PrismaListingRepo(
    { prismaClientProvider: provider, writeFinalizerFactory: () => finalizer },
    { maxQueryResultCount: 500, listingSearchTextColumns: [] },
  );
  const batchSql = readFileSync(
    join(__dirname, "02-preview-batch.sql"),
    "utf8",
  );
  const verifySql = readFileSync(
    join(__dirname, "03-verify-progress.sql"),
    "utf8",
  );
  const sourceFields = new Set([
    "stockQtyAvailable",
    "stockQtyOnHand",
    "stockQtyExpected",
    "stockReconciledAt",
    "assemblyQtyAvailable",
    "assemblyQtyOnHand",
    "assemblyQtyExpected",
    "assemblyReconciledAt",
  ]);
  const originalDate = new Date("2026-11-10T01:00:00.000Z");
  const newerDate = new Date("2026-11-10T02:00:00.000Z");
  const channel = mockChannel({}, "sql-lab-channel");
  let prisma: PrismaClient;
  let observer: PrismaClient;

  const publicState = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(([name]) => !sourceFields.has(name)),
    );

  const startSql = (sql: string, hold = false) => {
    const child = spawn("docker", [
      "exec",
      "-i",
      "multiple-db-database-1",
      "psql",
      "-U",
      "root",
      "-d",
      database,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-At",
      "-F",
      "\t",
    ]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.stdin.end("ROLLBACK;\n");
      child.kill("SIGTERM");
    }, 7000);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const result = new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve(stdout)
          : reject(new Error(stderr || "Local psql rehearsal timed out"));
      });
    });
    if (hold)
      child.stdin.write(
        sql.replace(/(?:ROLLBACK|COMMIT);\s*$/, "SELECT 'LAB_BATCH_READY';\n"),
      );
    else child.stdin.end(sql);
    return { result, release: () => child.stdin.end("COMMIT;\n") };
  };

  const sqlForBatch = (limit = 100, commit = true) =>
    batchSql
      .replace("LIMIT 100", `LIMIT ${limit}`)
      .replace(/ROLLBACK;\s*$/, commit ? "COMMIT;\n" : "ROLLBACK;\n");
  const runBatch = async (limit = 100, commit = true) => {
    const output = await startSql(sqlForBatch(limit, commit)).result;
    const summary = output
      .trim()
      .split("\n")
      .find((line) => /^\d+\t\d+$/.test(line));
    if (!summary) throw new Error(`Missing batch summary: ${output}`);
    return summary.split("\t").map(Number);
  };
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Did not observe the expected database interleaving");
  };
  const isBlocked = async () => {
    const rows = await observer.$queryRawUnsafe<{ blocked: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`,
    );
    return rows[0].blocked;
  };
  const seedListing = async (
    id: string,
    strategy = FulfillmentStrategy.STOCK,
    overrides = {},
  ) => {
    const listing = mockListing(
      {
        name: id,
        skuId: id,
        channel,
        fulfillmentStrategy: strategy,
        qtyAvailable: 4,
        qtyOnHand: 6,
        qtyExpected: 1,
        reconciledAt: originalDate,
      },
      id,
    );
    return prisma.listing.create({
      data: {
        ...PrismaListingMapper.toCreateInput(listing),
        qtyAvailable: 4,
        qtyOnHand: 6,
        qtyExpected: 1,
        qtyListed: 999,
        reconciledAt: originalDate,
        version: 8,
        stockQtyAvailable: 0,
        stockQtyOnHand: 0,
        stockQtyExpected: 0,
        stockReconciledAt: new Date(0),
        assemblyQtyAvailable: 0,
        assemblyQtyOnHand: 0,
        assemblyQtyExpected: 0,
        assemblyReconciledAt: new Date(0),
        ...overrides,
      },
    });
  };
  const loadLive = async (id: string) => {
    const result = await repo.getById(id);
    if (result.isSad()) throw new Error(result.value.errorValue().message);
    const listing = result.value.getValue();
    if (!listing) throw new Error("Missing live listing");
    listing.set({
      qtyAvailable: 7,
      qtyOnHand: 9,
      qtyExpected: 2,
      reconciledAt: newerDate,
    });
    return listing;
  };
  const assertFresh = async () => {
    expect(
      await prisma.listing.findUniqueOrThrow({ where: { id: "a" } }),
    ).toMatchObject({
      qtyAvailable: 7,
      qtyOnHand: 9,
      qtyExpected: 2,
      reconciledAt: newerDate,
      stockQtyAvailable: 7,
      stockQtyOnHand: 9,
      stockQtyExpected: 2,
      stockReconciledAt: newerDate,
      version: 10,
    });
  };

  beforeAll(async () => {
    prisma = await provider.getReadWriter();
    observer = await observerProvider.getReadWriter();
    const identity = await prisma.$queryRawUnsafe<{ name: string }[]>(
      "SELECT current_database() AS name",
    );
    if (identity[0].name !== database) throw new Error("Wrong local database");
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS sql_lab_update_audit (listing_id text, changed_columns text[])",
    );
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sql_lab_audit_listing_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO sql_lab_update_audit SELECT NEW.id, array_agg(key ORDER BY key)
      FROM jsonb_each(to_jsonb(NEW)) WHERE value IS DISTINCT FROM (to_jsonb(OLD) -> key); RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS sql_lab_audit_listing_update ON public."Listing"',
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER sql_lab_audit_listing_update AFTER UPDATE ON public."Listing" FOR EACH ROW EXECUTE FUNCTION sql_lab_audit_listing_update()',
    );
  });
  beforeEach(async () => {
    jest.resetAllMocks();
    finalizer.finalize.mockResolvedValue(undefined);
    await prisma.listingAssemblyComponent.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.$executeRawUnsafe("TRUNCATE sql_lab_update_audit");
    await prisma.channel.create({
      data: PrismaChannelMapper.toCreateInput(channel),
    });
  });
  afterAll(async () => {
    await provider.dispose();
    await observerProvider.dispose();
  });

  describe("when previewing a mismatched listing", () => {
    let before: Awaited<ReturnType<typeof seedListing>>;
    beforeEach(async () => {
      before = await seedListing("a");
    });
    it("reports work but rolls back every change", async () => {
      expect(await runBatch(100, false)).toEqual([1, 1]);
      expect(
        await prisma.listing.findUniqueOrThrow({ where: { id: "a" } }),
      ).toEqual(before);
    });
  });

  describe.each`
    strategy
    ${FulfillmentStrategy.STOCK}
    ${FulfillmentStrategy.BUNDLE}
    ${FulfillmentStrategy.STOCK_THEN_ASSEMBLY}
  `("when migrating $strategy", ({ strategy }) => {
    let before: Awaited<ReturnType<typeof seedListing>>;
    beforeEach(async () => {
      before = await seedListing("a", strategy);
    });
    it("changes only source columns, performs one update and is repeatable", async () => {
      expect(await runBatch()).toEqual([1, 1]);
      const after = await prisma.listing.findUniqueOrThrow({
        where: { id: "a" },
      });
      const stock = strategy === FulfillmentStrategy.STOCK;
      expect(after).toMatchObject({
        stockQtyAvailable: stock ? 4 : null,
        stockQtyOnHand: stock ? 6 : null,
        stockQtyExpected: stock ? 1 : null,
        stockReconciledAt: stock ? originalDate : null,
        assemblyQtyAvailable: stock ? null : 4,
        assemblyQtyOnHand: stock ? null : 6,
        assemblyQtyExpected: stock ? null : 1,
        assemblyReconciledAt: stock ? null : originalDate,
      });
      expect(publicState(after)).toEqual(publicState(before));
      expect(await runBatch()).toEqual([0, 0]);
      expect(
        await prisma.$queryRawUnsafe("SELECT * FROM sql_lab_update_audit"),
      ).toHaveLength(1);
    });
  });

  describe("when the limit is smaller than the remaining work", () => {
    beforeEach(async () => {
      await seedListing("a");
      await seedListing("b");
      await seedListing("c");
    });
    it("updates only the requested number and verification tracks committed progress", async () => {
      expect(await runBatch(1)).toEqual([1, 1]);
      const output = await startSql(verifySql).result;
      const all = output
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
        .find((parts) => parts[1] === "ALL");
      expect(all?.slice(2)).toEqual(["3", "1", "2", "0", "33.33"]);
      expect(await runBatch(1)).toEqual([1, 1]);
      expect(await runBatch(1)).toEqual([1, 1]);
      expect(await runBatch(1)).toEqual([0, 0]);
      expect(await startSql(verifySql).result).toContain(
        "\tALL\t3\t3\t0\t0\t100.00",
      );
    });
  });

  describe("when the active source is NULL and public values are zero", () => {
    beforeEach(async () => {
      await seedListing("a", FulfillmentStrategy.STOCK, {
        qtyAvailable: 0,
        qtyOnHand: 0,
        qtyExpected: 0,
        reconciledAt: new Date(0),
        stockQtyAvailable: null,
        stockQtyOnHand: null,
        stockQtyExpected: null,
        stockReconciledAt: null,
        assemblyQtyAvailable: null,
        assemblyQtyOnHand: null,
        assemblyQtyExpected: null,
        assemblyReconciledAt: null,
      });
    });
    it("detects NULL mismatches and writes zero values with the epoch date", async () => {
      expect(await runBatch()).toEqual([1, 1]);
      expect(
        await prisma.listing.findUniqueOrThrow({ where: { id: "a" } }),
      ).toMatchObject({
        stockQtyAvailable: 0,
        stockQtyOnHand: 0,
        stockQtyExpected: 0,
        stockReconciledAt: new Date(0),
      });
      expect(await runBatch()).toEqual([0, 0]);
    });
  });

  describe("when only the inactive source is wrong", () => {
    beforeEach(async () => {
      await seedListing("a", FulfillmentStrategy.STOCK, {
        stockQtyAvailable: 4,
        stockQtyOnHand: 6,
        stockQtyExpected: 1,
        stockReconciledAt: originalDate,
      });
    });
    it("selects the row and clears only its inactive source", async () => {
      expect(await runBatch()).toEqual([1, 1]);
      const audit = await prisma.$queryRawUnsafe<
        { changed_columns: string[] }[]
      >("SELECT changed_columns FROM sql_lab_update_audit");
      expect(audit[0].changed_columns).toEqual([
        "assembly_qty_available",
        "assembly_qty_expected",
        "assembly_qty_on_hand",
        "assembly_reconciled_at",
      ]);
    });
  });

  describe("when SQL commits before a previously loaded live save", () => {
    beforeEach(async () => {
      await seedListing("a");
    });
    it("allows the live save and retains its newer quantities and date", async () => {
      const live = await loadLive("a");
      await runBatch();
      const result = await repo.save(live);
      if (result.isSad()) throw new Error(result.value.errorValue().message);
      await assertFresh();
    });
  });

  describe("when the live save commits first", () => {
    beforeEach(async () => {
      await seedListing("a");
    });
    it("leaves the already corrected row alone", async () => {
      const result = await repo.save(await loadLive("a"));
      if (result.isSad()) throw new Error(result.value.errorValue().message);
      expect(await runBatch()).toEqual([0, 0]);
      await assertFresh();
    });
  });

  describe("when a live save holds the row lock before SQL", () => {
    let release: () => void;
    let written: boolean;
    beforeEach(async () => {
      await seedListing("a");
      written = false;
      const holding = new Promise<void>((resolve) => {
        release = resolve;
      });
      finalizer.finalize.mockImplementationOnce(async () => {
        written = true;
        await holding;
      });
    });
    it("rechecks the live values after waiting and skips the corrected row", async () => {
      const liveSave = repo.save(await loadLive("a"));
      await waitFor(async () => written);
      const sql = runBatch();
      try {
        await waitFor(isBlocked);
      } finally {
        release();
      }
      const liveResult = await liveSave;
      if (liveResult.isSad())
        throw new Error(liveResult.value.errorValue().message);
      expect(await sql).toEqual([1, 0]);
      await assertFresh();
    });
  });

  describe("when SQL holds the row lock before a live save", () => {
    beforeEach(async () => {
      await seedListing("a");
    });
    it("lets the previously loaded live writer save after SQL commits", async () => {
      const live = await loadLive("a");
      const sql = startSql(sqlForBatch(), true);
      await waitFor(async () => {
        const rows = await observer.$queryRawUnsafe<
          { ready: boolean }[]
        >(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'listing-source-props-backfill-pilot'
          AND state = 'idle in transaction' AND query LIKE '%LAB_BATCH_READY%') AS ready`);
        return rows[0].ready;
      });
      const liveSave = repo.save(live);
      try {
        await waitFor(isBlocked);
      } finally {
        sql.release();
      }
      await sql.result;
      const result = await liveSave;
      if (result.isSad()) throw new Error(result.value.errorValue().message);
      await assertFresh();
    });
  });
});
