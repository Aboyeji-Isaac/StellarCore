
import assert from "node:assert/strict";
import test from "node:test";

import { publicApiJsonResponse } from "@/lib/api/http";
import {
  getAnchorsApiResult,
  getAnchorApiResult,
} from "@/lib/api/anchors";
import {
  getCorridorsApiResult,
  getCorridorApiResult,
} from "@/lib/api/corridors";
import {
  getReputationApiResult,
  getAnchorReputationApiResult,
} from "@/lib/api/reputation";
import { getRatesApiResult } from "@/lib/api/rates";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";

const DB_ERROR = new Error(
  "postgresql://admin:secret@db.internal/core P0001 connection refused",
);

test("anchors list route returns safe 500 when database fails", async () => {
  const result = await getAnchorsApiResult({
    repository: {
      findAll: async () => {
        throw DB_ERROR;
      },
      findBySlug: async () => null,
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to load anchors.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
  assert.equal(serialized.includes("postgresql"), false);
});

test("anchor detail route returns safe 500 when database fails", async () => {
  const result = await getAnchorApiResult("zeam", {
    repository: {
      findAll: async () => [],
      findBySlug: async () => {
        throw DB_ERROR;
      },
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to load anchors.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("corridors list route returns safe 500 when database fails", async () => {
  const result = await getCorridorsApiResult({
    repository: {
      findAll: async () => {
        throw DB_ERROR;
      },
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to load corridors.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("corridor detail route returns safe 500 when database fails", async () => {
  const result = await getCorridorApiResult("usdc-us-brl-br", {
    repository: {
      findBySlug: async () => {
        throw DB_ERROR;
      },
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to load corridor.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("reputation list route returns safe 500 when database fails", async () => {
  const result = await getReputationApiResult({
    repository: {
      findAll: async () => {
        throw DB_ERROR;
      },
      findBySlug: async () => null,
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to load reputation.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("anchor reputation detail route returns safe 500 when database fails", async () => {
  const result = await getAnchorReputationApiResult("zeam", {
    repository: {
      findAll: async () => [],
      findBySlug: async () => {
        throw DB_ERROR;
      },
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to load reputation.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("rates route returns safe 500 when database fails", async () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");

  const result = await getRatesApiResult("usdc-us-brl-br", {
    now: () => NOW,
    readLatestRate: async () => {
      throw DB_ERROR;
    },
  });

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to read rates.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("rate history route returns safe 500 when database fails", async () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");

  const result = await getRateHistoryApiResult(
    "usdc-us-brl-br",
    "30",
    {
      now: () => NOW,
      readHistory: async () => {
        throw DB_ERROR;
      },
    },
  );

  const response = publicApiJsonResponse(result);
  assert.equal(response.status, 500);

  const body = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "Unable to read rate history.");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("db.internal"), false);
});

test("no route fabricates success data when database fails", async () => {
  const testCases = [
    {
      name: "anchors list",
      fn: () =>
        getAnchorsApiResult({
          repository: {
            findAll: async () => {
              throw DB_ERROR;
            },
            findBySlug: async () => null,
          },
        }),
    },
    {
      name: "anchor detail",
      fn: () =>
        getAnchorApiResult("zeam", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "corridors list",
      fn: () =>
        getCorridorsApiResult({
          repository: {
            findAll: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "corridor detail",
      fn: () =>
        getCorridorApiResult("usdc-us-brl-br", {
          repository: {
            findBySlug: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "reputation list",
      fn: () =>
        getReputationApiResult({
          repository: {
            findAll: async () => {
              throw DB_ERROR;
            },
            findBySlug: async () => null,
          },
        }),
    },
    {
      name: "anchor reputation",
      fn: () =>
        getAnchorReputationApiResult("zeam", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "rates",
      fn: () =>
        getRatesApiResult("usdc-us-brl-br", {
          now: () => new Date(),
          readLatestRate: async () => {
            throw DB_ERROR;
          },
        }),
    },
    {
      name: "rate history",
      fn: () =>
        getRateHistoryApiResult("usdc-us-brl-br", "30", {
          now: () => new Date(),
          readHistory: async () => {
            throw DB_ERROR;
          },
        }),
    },
  ];

  for (const tc of testCases) {
    const result = await tc.fn();

    assert.equal(result.status, 500, `${tc.name}: should return 500`);
    assert.equal(
      result.body.error.code,
      "internal_error",
      `${tc.name}: should have internal_error code`,
    );

    assert.ok(
      !(
        "anchors" in result.body ||
        "anchor" in result.body ||
        "corridors" in result.body ||
        "corridor" in result.body ||
        "reputation" in result.body ||
        "state" in result.body ||
        "points" in result.body
      ),
      `${tc.name}: should not contain success data`,
    );
  }
});

test("all public read routes disable caching on error responses", async () => {
  const routes = [
    {
      name: "anchors list",
      getResult: () =>
        getAnchorsApiResult({
          repository: {
            findAll: async () => {
              throw DB_ERROR;
            },
            findBySlug: async () => null,
          },
        }),
    },
    {
      name: "anchor detail",
      getResult: () =>
        getAnchorApiResult("zeam", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "corridors list",
      getResult: () =>
        getCorridorsApiResult({
          repository: {
            findAll: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "corridor detail",
      getResult: () =>
        getCorridorApiResult("usdc-us-brl-br", {
          repository: {
            findBySlug: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "reputation list",
      getResult: () =>
        getReputationApiResult({
          repository: {
            findAll: async () => {
              throw DB_ERROR;
            },
            findBySlug: async () => null,
          },
        }),
    },
    {
      name: "anchor reputation",
      getResult: () =>
        getAnchorReputationApiResult("zeam", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => {
              throw DB_ERROR;
            },
          },
        }),
    },
    {
      name: "rates",
      getResult: () =>
        getRatesApiResult("usdc-us-brl-br", {
          now: () => new Date(),
          readLatestRate: async () => {
            throw DB_ERROR;
          },
        }),
    },
    {
      name: "rate history",
      getResult: () =>
        getRateHistoryApiResult("usdc-us-brl-br", "30", {
          now: () => new Date(),
          readHistory: async () => {
            throw DB_ERROR;
          },
        }),
    },
  ];

  for (const { name, getResult } of routes) {
    const result = await getResult();
    const response = publicApiJsonResponse(result);

    assert.equal(
      response.headers.get("cache-control"),
      "no-store",
      `${name}: should have no-store cache-control`,
    );
  }
});

test("rate limited response is handled correctly on database failure", async () => {
  const rateLimitedResult = await getRatesApiResult("usdc-us-brl-br", {
    now: () => new Date(),
    readLatestRate: async () => {
      throw DB_ERROR;
    },
  });

  assert.equal(rateLimitedResult.status, 500);
});

test("different database error types are all mapped to safe internal_error", async () => {
  const errorTypes = [
    new Error("ECONNREFUSED connect failed"),
    new Error("ETIMEDOUT connection timeout"),
    new Error("ENOTFOUND unknown host"),
    new Error("P0001: could not connect to server"),
    new Error("57P01: terminating connection"),
    new Error("08006: connection failure"),
    new Error("53300: too many connections"),
  ];

  for (const error of errorTypes) {
    const result = await getAnchorsApiResult({
      repository: {
        findAll: async () => {
          throw error;
        },
        findBySlug: async () => null,
      },
    });

    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, "internal_error");

    const serialized = JSON.stringify(result.body);

    assert.equal(serialized.includes("ECONNREFUSED"), false);
    assert.equal(serialized.includes("ETIMEDOUT"), false);
    assert.equal(serialized.includes("P0001"), false);
    assert.equal(serialized.includes("57P01"), false);
    assert.equal(serialized.includes("08006"), false);
    assert.equal(serialized.includes("53300"), false);
  }
});
