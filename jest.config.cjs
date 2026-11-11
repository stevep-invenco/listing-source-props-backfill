const path = require("node:path");
const repo = path.resolve(__dirname, "../../worktrees/sales-eng-7130");
const { pathsToModuleNameMapper } = require(
  require.resolve("ts-jest", { paths: [repo] }),
);
const { compilerOptions } = require(path.join(repo, "tsconfig.base.json"));
module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/listing-source-props-backfill.test.ts"],
  transform: {
    "^.+\\.ts$": [
      require.resolve("ts-jest", { paths: [repo] }),
      {
        tsconfig: path.join(repo, "projects/sales-service/tsconfig.json"),
        diagnostics: false,
      },
    ],
  },
  modulePaths: [
    path.join(repo, "node_modules"),
    path.join(repo, "projects/sales-service/node_modules"),
  ],
  moduleNameMapper: {
    ...pathsToModuleNameMapper(compilerOptions.paths, { prefix: `${repo}/` }),
    "^@prisma/client$": path.join(
      repo,
      "projects/sales-service/prisma/.generated/client",
    ),
  },
  testTimeout: 15000,
};
