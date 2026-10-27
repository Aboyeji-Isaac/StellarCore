import assert from "node:assert/strict";
import test from "node:test";

import { isTransientDatabaseFailure } from "@/lib/databaseErrors";

test("recognizes shared failover and network errors", () => {
  for (const code of [
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
    "08006",
    "57P01",
    "25006",
  ]) {
    assert.equal(
      isTransientDatabaseFailure(Object.assign(new Error(code), { code })),
      true,
      code,
    );
  }
});

test("recognizes Prisma pool/connectivity exhaustion codes", () => {
  for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024", "P2037", "53300"]) {
    assert.equal(
      isTransientDatabaseFailure(Object.assign(new Error(code), { code })),
      true,
      code,
    );
  }
});

test("walks nested Prisma/driver errors", () => {
  const error = {
    code: "P5000",
    originalError: {
      driverError: Object.assign(new Error("server closed"), { code: "08006" }),
    },
  };
  assert.equal(isTransientDatabaseFailure(error), true);
});

test("fails closed for non-transient initialization and query errors", () => {
  assert.equal(
    isTransientDatabaseFailure(
      Object.assign(new Error("invalid credentials"), {
        name: "PrismaClientInitializationError",
        code: "P1000",
      }),
    ),
    false,
  );
  assert.equal(
    isTransientDatabaseFailure(
      Object.assign(new Error("unique violation"), { code: "23505" }),
    ),
    false,
  );
  assert.equal(isTransientDatabaseFailure(new Error("application bug")), false);
});
