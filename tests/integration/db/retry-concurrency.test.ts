import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { PrismaClient } from "@prisma/client";

import { withTransactionRetry, RetryExhaustedError, DEFAULT_RETRY_POLICY } from "@/lib/db/retry";

const prisma = new PrismaClient();

const TEST_ANCHOR_SLUG = "retry-test-anchor";
const TEST_CORRIDOR_SLUG = "retry-test-corridor";

async function setupTestData() {
  await prisma.anchorCorridor.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.rateSnapshot.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.transferOutcome.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.reputationScore.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.anchor.deleteMany({
    where: { slug: TEST_ANCHOR_SLUG },
  });
  await prisma.corridor.deleteMany({
    where: { slug: TEST_CORRIDOR_SLUG },
  });

  const anchor = await prisma.anchor.create({
    data: {
      slug: TEST_ANCHOR_SLUG,
      name: "Retry Test Anchor",
      homeDomain: "example.com",
      tomlUrl: "https://example.com/.well-known/stellar.toml",
      seps: [1, 38],
      isTransferCapable: true,
      status: "LIVE",
    },
  });

  const corridor = await prisma.corridor.create({
    data: {
      slug: TEST_CORRIDOR_SLUG,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "US",
    },
  });

  await prisma.anchorCorridor.create({
    data: {
      anchorId: anchor.id,
      corridorId: corridor.id,
    },
  });

  return { anchorId: anchor.id, corridorId: corridor.id };
}

async function cleanupTestData() {
  await prisma.anchorCorridor.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.rateSnapshot.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.transferOutcome.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.reputationScore.deleteMany({
    where: {
      anchor: { slug: TEST_ANCHOR_SLUG },
    },
  });
  await prisma.anchor.deleteMany({
    where: { slug: TEST_ANCHOR_SLUG },
  });
  await prisma.corridor.deleteMany({
    where: { slug: TEST_CORRIDOR_SLUG },
  });
}

describe("withTransactionRetry integration tests", () => {
  before(async () => {
    await setupTestData();
  });

  after(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  it("retries and succeeds on serialization failure under concurrent writes", async () => {
    const { anchorId, corridorId } = await setupTestData();

    const barrier = new Promise<void>((resolve) => {
      let count = 0;
      return () => {
        count++;
        if (count === 2) resolve();
      };
    }) as Promise<void> & { release: () => void };

    let releaseBarrier: () => void;
    const waitBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    (barrier as { release: () => void }).release = releaseBarrier;

    const results: string[] = [];
    const errors: Error[] = [];

    async function concurrentWriter(writerId: number) {
      await withTransactionRetry(
        async () => {
          await prisma.$transaction(
            async (tx) => {
              await tx.rateSnapshot.create({
                data: {
                  anchorId,
                  corridorId,
                  rate: 1.0,
                  sourceAmount: 100,
                  destinationAmount: 100,
                  fee: 0,
                  capturedAt: new Date(),
                },
              });

              if (writerId === 1) {
                await waitBarrier;
              } else {
                (barrier as { release: () => void }).release();
                await waitBarrier;
              }

              await tx.rateSnapshot.create({
                data: {
                  anchorId,
                  corridorId,
                  rate: 1.0,
                  sourceAmount: 200,
                  destinationAmount: 200,
                  fee: 0,
                  capturedAt: new Date(),
                },
              });
            },
            {
              isolationLevel: "Serializable",
            },
          );
          results.push(`writer-${writerId}`);
        },
        {
          policy: {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: 5,
            baseDelayMs: 10,
            maxDelayMs: 100,
            deadlineMs: 5000,
          },
        },
      );
    }

    await Promise.all([
      concurrentWriter(1).catch((e) => errors.push(e)),
      concurrentWriter(2).catch((e) => errors.push(e)),
    ]);

    assert.equal(errors.length, 0, `Expected no errors, got: ${errors.map((e) => e.message).join(", ")}`);
    assert.equal(results.length, 2);
  });

  it("handles deadlock with consistent lock ordering", async () => {
    const { anchorId, corridorId } = await setupTestData();

    const results: string[] = [];
    const errors: Error[] = [];

    async function deadlockWriter(writerId: number, lockOrder: "anchor-first" | "corridor-first") {
      await withTransactionRetry(
        async () => {
          await prisma.$transaction(
            async (tx) => {
              if (lockOrder === "anchor-first") {
                await tx.anchor.update({
                  where: { id: anchorId },
                  data: { updatedAt: new Date() },
                });
                await new Promise((resolve) => setTimeout(resolve, 10));
                await tx.corridor.update({
                  where: { id: corridorId },
                  data: { slug: TEST_CORRIDOR_SLUG + "-" + writerId },
                });
              } else {
                await tx.corridor.update({
                  where: { id: corridorId },
                  data: { slug: TEST_CORRIDOR_SLUG + "-" + writerId },
                });
                await new Promise((resolve) => setTimeout(resolve, 10));
                await tx.anchor.update({
                  where: { id: anchorId },
                  data: { updatedAt: new Date() },
                });
              }
            },
            {
              isolationLevel: "Serializable",
            },
          );
          results.push(`writer-${writerId}`);
        },
        {
          policy: {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: 5,
            baseDelayMs: 10,
            maxDelayMs: 100,
            deadlineMs: 5000,
          },
        },
      );
    }

    await Promise.all([
      deadlockWriter(1, "anchor-first").catch((e) => errors.push(e)),
      deadlockWriter(2, "corridor-first").catch((e) => errors.push(e)),
    ]);

    assert.equal(errors.length, 0, `Expected no errors, got: ${errors.map((e) => e.message).join(", ")}`);
    assert.equal(results.length, 2);
  });

  it("exhausts retries and throws RetryExhaustedError under sustained contention", async () => {
    const { anchorId, corridorId } = await setupTestData();

    let attemptCount = 0;
    let lastError: Error | null = null;

    try {
      await withTransactionRetry(
        async () => {
          attemptCount++;
          await prisma.$transaction(
            async (tx) => {
              await tx.rateSnapshot.create({
                data: {
                  anchorId,
                  corridorId,
                  rate: 1.0,
                  sourceAmount: 100,
                  destinationAmount: 100,
                  fee: 0,
                  capturedAt: new Date(),
                },
              });

              if (attemptCount < 10) {
                const [other] = await prisma.$queryRaw<{ pid: number }[]>`
                  SELECT pid FROM pg_stat_activity
                  WHERE state = 'active' AND pid != pg_backend_pid()
                  LIMIT 1
                `;

                if (other) {
                  await prisma.$executeRaw`SELECT pg_terminate_backend(${other.pid})`;
                }
              }

              await tx.rateSnapshot.create({
                data: {
                  anchorId,
                  corridorId,
                  rate: 1.0,
                  sourceAmount: 200,
                  destinationAmount: 200,
                  fee: 0,
                  capturedAt: new Date(),
                },
              });
            },
            {
              isolationLevel: "Serializable",
            },
          );
        },
        {
          policy: {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: 3,
            baseDelayMs: 5,
            maxDelayMs: 20,
            deadlineMs: 1000,
          },
        },
      );
    } catch (error) {
      lastError = error as Error;
    }

    assert.ok(lastError instanceof RetryExhaustedError, `Expected RetryExhaustedError, got ${lastError?.constructor.name}`);
    assert.equal(attemptCount, 3);
  });

  it("does not retry foreign key violations", async () => {
    await setupTestData();

    let lastError: Error | null = null;
    let attemptCount = 0;

    try {
      await withTransactionRetry(
        async () => {
          attemptCount++;
          await prisma.$transaction(async (tx) => {
            await tx.rateSnapshot.create({
              data: {
                anchorId: "00000000-0000-0000-0000-000000000000",
                corridorId,
                rate: 1.0,
                sourceAmount: 100,
                destinationAmount: 100,
                fee: 0,
                capturedAt: new Date(),
              },
            });
          });
        },
        {
          policy: {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: 3,
            baseDelayMs: 1,
            maxDelayMs: 5,
            deadlineMs: 1000,
          },
        },
      );
    } catch (error) {
      lastError = error as Error;
    }

    assert.ok(lastError !== null);
    assert.ok(!(lastError instanceof RetryExhaustedError), "Should not retry FK violation");
    assert.equal(attemptCount, 1);
  });

  it("respects AbortSignal during retry delay", async () => {
    const { anchorId, corridorId } = await setupTestData();

    const controller = new AbortController();
    let lastError: Error | null = null;

    setTimeout(() => controller.abort(), 50);

    try {
      await withTransactionRetry(
        async (signal) => {
          await prisma.$transaction(
            async (tx) => {
              await tx.rateSnapshot.create({
                data: {
                  anchorId,
                  corridorId,
                  rate: 1.0,
                  sourceAmount: 100,
                  destinationAmount: 100,
                  fee: 0,
                  capturedAt: new Date(),
                },
              });

              await new Promise<void>((resolve, reject) => {
                signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                  once: true,
                });
                setTimeout(resolve, 1000);
              });
            },
            {
              isolationLevel: "Serializable",
            },
          );
        },
        {
          policy: {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: 10,
            baseDelayMs: 50,
            maxDelayMs: 100,
            deadlineMs: 5000,
          },
        },
      );
    } catch (error) {
      lastError = error as Error;
    }

    assert.ok(lastError instanceof DOMException);
    assert.equal(lastError!.name, "AbortError");
  });
});