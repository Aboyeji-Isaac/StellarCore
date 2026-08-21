import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireStellarAuthToken,
  parseStellarAuthToken,
  StellarAuthError,
} from "@/lib/stellar/auth";
import type { StellarAuthToken } from "@/types/stellarAuth";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const SUBJECT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

test("authentication providers return validated immutable tokens", async () => {
  const raw = testJwt({
    iss: "https://auth.anchor.example",
    sub: SUBJECT,
    iat: seconds(NOW) - 30,
    exp: seconds(NOW) + 300,
  });
  const token = tokenFrom(raw);

  const acquired = await acquireStellarAuthToken(
    { getToken: async () => token },
    { now: NOW },
  );

  assert.equal(acquired, token);
  assert.equal(Object.isFrozen(acquired), true);
});

test("empty, whitespace, control-character, and malformed JWT values are rejected", () => {
  for (const value of ["", " ", "header.payload.signature\n", "not-a-jwt"]) {
    assert.throws(
      () =>
        parseStellarAuthToken(
          value,
          {
            protocol: "sep10",
            homeDomain: "anchor.example",
            expectedSubject: SUBJECT,
          },
          { now: NOW },
        ),
      hasAuthCode("INVALID_TOKEN"),
    );
  }
});

test("token timestamps and expiry are enforced", () => {
  const expired = testJwt({
    iss: "https://auth.anchor.example",
    sub: SUBJECT,
    iat: seconds(NOW) - 600,
    exp: seconds(NOW),
  });
  const futureIssued = testJwt({
    iss: "https://auth.anchor.example",
    sub: SUBJECT,
    iat: seconds(NOW) + 301,
    exp: seconds(NOW) + 600,
  });

  assert.throws(
    () => parse(expired),
    hasAuthCode("TOKEN_EXPIRED"),
  );
  assert.throws(
    () => parse(futureIssued),
    hasAuthCode("INVALID_TOKEN"),
  );
});

test("provider failures are normalized without leaking token material", async () => {
  const sensitive = "private.bearer.material";

  await assert.rejects(
    acquireStellarAuthToken({
      getToken: async () => {
        throw new Error(`provider exposed ${sensitive}`);
      },
    }),
    (error) =>
      error instanceof StellarAuthError &&
      error.code === "PROVIDER_FAILURE" &&
      !error.message.includes(sensitive) &&
      !("cause" in error),
  );
});

function parse(value: string): StellarAuthToken {
  return parseStellarAuthToken(
    value,
    {
      protocol: "sep10",
      homeDomain: "anchor.example",
      expectedSubject: SUBJECT,
    },
    { now: NOW },
  );
}

function tokenFrom(value: string): StellarAuthToken {
  return parse(value);
}

function testJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "test" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.synthetic-signature`;
}

function seconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

function hasAuthCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof StellarAuthError && error.code === code;
}
