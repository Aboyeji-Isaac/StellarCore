import assert from "node:assert/strict";
import test from "node:test";

import {
  assessObservation,
  buildSep1Observation,
  diffSensitiveMetadata,
  SEP1_CANONICAL_VERSION,
} from "@/lib/stellar/sep1History";
import { parseSep1Toml } from "@/lib/stellar/sep1";
import type { DiscoveredAnchor } from "@/types/anchor";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const TOML_A = `
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
SIGNING_KEY = "GBSIGNINGKEY"
ANCHOR_QUOTE_SERVER = "https://Quote.Example.com:443/sep38"
WEB_AUTH_ENDPOINT = "https://auth.example.com/auth"
[DOCUMENTATION]
ORG_NAME = "Example"
[[CURRENCIES]]
code = "USDC"
issuer = "${ISSUER}"
status = "live"
[[CURRENCIES]]
code = "EURC"
issuer = "${ISSUER}"
`;

// Same metadata: different key order, comments, quoting styles, endpoint
// spelling (host case, default port) and currency order.
const TOML_B = `
# reordered
SIGNING_KEY   =   'GBSIGNINGKEY'
WEB_AUTH_ENDPOINT = 'https://AUTH.example.com:443/auth'
NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
ANCHOR_QUOTE_SERVER = "https://quote.example.com/sep38"
[[CURRENCIES]]
issuer = '${ISSUER}'
code = 'EURC'
[[CURRENCIES]]
status = "live"
code = "USDC"
issuer = "${ISSUER}"
[DOCUMENTATION]
ORG_NAME = "Example"
`;

function observe(toml: string) {
  const data = parseSep1Toml(toml);
  return buildSep1Observation(data);
}

test("equivalent TOML representations yield the same digests", () => {
  const a = observe(TOML_A);
  const b = observe(TOML_B);

  assert.equal(a.digest, b.digest);
  assert.equal(a.sensitiveDigest, b.sensitiveDigest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(a.version, SEP1_CANONICAL_VERSION);
  assert.equal(a.metadata.endpoints.anchorQuoteServer, "https://quote.example.com/sep38");
});

test("non-sensitive edits change the digest but not the sensitive digest", () => {
  const base = observe(TOML_A);
  const renamed = observe(TOML_A.replace('ORG_NAME = "Example"', 'ORG_NAME = "Example Inc"'));
  const restatus = observe(TOML_A.replace('status = "live"', 'status = "test"'));

  assert.notEqual(base.digest, renamed.digest);
  assert.equal(base.sensitiveDigest, renamed.sensitiveDigest);
  assert.equal(base.sensitiveDigest, restatus.sensitiveDigest);
  assert.deepEqual(assessObservation(base.sensitive, renamed), {
    assessment: "MATCHES_BASELINE",
    diff: [],
  });
});

test("signing key, passphrase, endpoint and asset changes produce a deterministic field diff", () => {
  const base = observe(TOML_A);
  const changed = observe(
    TOML_A
      .replace("GBSIGNINGKEY", "GBOTHERKEY")
      .replace("https://auth.example.com/auth", "https://evil.example.com/auth")
      .replace('code = "EURC"', 'code = "EURX"')
      .replace("September 2015", "September 2016"),
  );

  const first = assessObservation(base.sensitive, changed);
  const second = assessObservation(base.sensitive, changed);

  assert.equal(first.assessment, "CHANGED_UNREVIEWED");
  assert.deepEqual(first, second);
  assert.deepEqual(first.diff.map(({ field }) => field), [
    "assets.EURC:" + ISSUER,
    "assets.EURX:" + ISSUER,
    "endpoints.webAuthEndpoint",
    "networkPassphrase",
    "signingKey",
  ]);
  const key = first.diff.find(({ field }) => field === "signingKey");
  assert.deepEqual(key, { field: "signingKey", before: "GBSIGNINGKEY", after: "GBOTHERKEY" });
});

test("no baseline is reported as NO_BASELINE with every populated field listed", () => {
  const result = assessObservation(null, observe(TOML_A));
  assert.equal(result.assessment, "NO_BASELINE");
  assert.ok(result.diff.some(({ field }) => field === "signingKey"));
  assert.ok(result.diff.every(({ before }) => before === null));
});

test("URL userinfo and query secrets are not stored but query changes are detected", () => {
  const secret = "s3cr3t-token";
  const toml = TOML_A.replace(
    "https://auth.example.com/auth",
    `https://user:pass@auth.example.com/auth?token=${secret}#frag`,
  );
  const a = observe(toml);
  const stored = JSON.stringify(a.metadata);

  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes("user:pass"));
  assert.ok(!stored.includes("frag"));

  const b = observe(toml.replace(secret, "other"));
  assert.notEqual(a.sensitiveDigest, b.sensitiveDigest);
  assert.deepEqual(
    diffSensitiveMetadata(a.sensitive, b.sensitive).map(({ field }) => field),
    ["endpoints.webAuthEndpoint"],
  );
});

test("duplicate assets collapse and the digest ignores raw TOML formatting", () => {
  const data = parseSep1Toml(TOML_A);
  const duplicated = buildSep1Observation({
    ...(data as unknown as DiscoveredAnchor),
    assets: [...data.assets, ...data.assets],
  });
  assert.equal(duplicated.digest, buildSep1Observation(data).digest);
});
