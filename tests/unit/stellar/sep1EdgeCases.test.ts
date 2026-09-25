import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSep1Toml,
  parseSep1Toml,
  Sep1DiscoveryError,
} from "@/lib/stellar/sep1";

const VALID_ROOT_FIELDS = `
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
`;

const VALID_DOC_TABLE = `
[DOCUMENTATION]
ORG_NAME = "Valid Anchor Organization"
ORG_URL = "https://anchor.example"
`;

const VALID_MINIMAL_TOML = `${VALID_ROOT_FIELDS}\n${VALID_DOC_TABLE}`;

function createByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Malformed and Unparseable TOML Syntax
// ---------------------------------------------------------------------------

test("parseSep1Toml: rejects unclosed double-quoted strings", () => {
  assert.throws(
    () =>
      parseSep1Toml(
        'NETWORK_PASSPHRASE = "unclosed string\n[DOCUMENTATION]\nORG_NAME = "Anchor"',
        "https://anchor.example/stellar.toml",
      ),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects incomplete key-value assignments", () => {
  assert.throws(
    () =>
      parseSep1Toml(
        'NETWORK_PASSPHRASE =\n[DOCUMENTATION]\nORG_NAME = "Anchor"',
        "https://anchor.example/stellar.toml",
      ),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects unclosed table headers", () => {
  assert.throws(
    () =>
      parseSep1Toml(
        'NETWORK_PASSPHRASE = "Valid"\n[DOCUMENTATION\nORG_NAME = "Anchor"',
        "https://anchor.example/stellar.toml",
      ),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects duplicate keys in the same root table", () => {
  const toml = `
NETWORK_PASSPHRASE = "First Passphrase"
NETWORK_PASSPHRASE = "Second Duplicate Passphrase"
[DOCUMENTATION]
ORG_NAME = "Anchor"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects duplicate keys inside DOCUMENTATION table", () => {
  const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"
[DOCUMENTATION]
ORG_NAME = "First Anchor"
ORG_NAME = "Second Anchor"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects duplicate table headers", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[DOCUMENTATION]
ORG_NAME = "Duplicate Table"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects unquoted raw control characters inside TOML values", () => {
  assert.throws(
    () =>
      parseSep1Toml(
        'NETWORK_PASSPHRASE = "Test\x00NullByte"\n[DOCUMENTATION]\nORG_NAME = "Anchor"',
        "https://anchor.example/stellar.toml",
      ),
    (err) =>
      err instanceof Sep1DiscoveryError && err.code === "INVALID_TOML",
  );
});

test("parseSep1Toml: rejects bare non-table primitive TOML document", () => {
  assert.throws(
    () =>
      parseSep1Toml(
        '"bare top-level string instead of key-value table"',
        "https://anchor.example/stellar.toml",
      ),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      (err.code === "INVALID_TOML" || err.code === "INVALID_DATA"),
  );
});

// ---------------------------------------------------------------------------
// 2. Missing Expected Fields & Required Data
// ---------------------------------------------------------------------------

test("parseSep1Toml: rejects missing NETWORK_PASSPHRASE", () => {
  const toml = `
[DOCUMENTATION]
ORG_NAME = "Anchor"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "MISSING_REQUIRED_DATA" &&
      err.message.includes("NETWORK_PASSPHRASE"),
  );
});

test("parseSep1Toml: rejects empty or whitespace-only NETWORK_PASSPHRASE", () => {
  for (const emptyVal of ['""', '"   "', '"""   """']) {
    const toml = `
NETWORK_PASSPHRASE = ${emptyVal}
[DOCUMENTATION]
ORG_NAME = "Anchor"
`;
    assert.throws(
      () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
      (err) =>
        err instanceof Sep1DiscoveryError &&
        err.code === "MISSING_REQUIRED_DATA" &&
        err.message.includes("NETWORK_PASSPHRASE"),
    );
  }
});

test("parseSep1Toml: rejects non-string NETWORK_PASSPHRASE", () => {
  for (const invalidVal of ["12345", "true", '["array"]']) {
    const toml = `
NETWORK_PASSPHRASE = ${invalidVal}
[DOCUMENTATION]
ORG_NAME = "Anchor"
`;
    assert.throws(
      () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
      (err) =>
        err instanceof Sep1DiscoveryError &&
        err.code === "MISSING_REQUIRED_DATA" &&
        err.message.includes("NETWORK_PASSPHRASE"),
    );
  }
});

test("parseSep1Toml: rejects missing DOCUMENTATION table", () => {
  const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "MISSING_REQUIRED_DATA" &&
      err.message.includes("DOCUMENTATION"),
  );
});

test("parseSep1Toml: rejects DOCUMENTATION declared as primitive or array instead of table", () => {
  const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"
DOCUMENTATION = "Not a table"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "MISSING_REQUIRED_DATA" &&
      err.message.includes("DOCUMENTATION"),
  );
});

test("parseSep1Toml: rejects missing ORG_NAME inside DOCUMENTATION", () => {
  const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"

[DOCUMENTATION]
ORG_URL = "https://anchor.example"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "MISSING_REQUIRED_DATA" &&
      err.message.includes("ORG_NAME"),
  );
});

test("parseSep1Toml: rejects empty or whitespace-only ORG_NAME", () => {
  for (const emptyVal of ['""', '"   "']) {
    const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"

[DOCUMENTATION]
ORG_NAME = ${emptyVal}
`;
    assert.throws(
      () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
      (err) =>
        err instanceof Sep1DiscoveryError &&
        err.code === "MISSING_REQUIRED_DATA" &&
        err.message.includes("ORG_NAME"),
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Field Types and Protocol Boundaries
// ---------------------------------------------------------------------------

test("parseSep1Toml: rejects insecure or malformed ORG_URL", () => {
  for (const badUrl of [
    '"http://insecure.anchor.example"',
    '"ftp://files.anchor.example"',
    '"not-a-valid-url"',
  ]) {
    const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"

[DOCUMENTATION]
ORG_NAME = "Anchor"
ORG_URL = ${badUrl}
`;
    assert.throws(
      () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
      (err) =>
        err instanceof Sep1DiscoveryError &&
        err.code === "INVALID_DATA" &&
        err.message.includes("ORG_URL"),
    );
  }
});

test("parseSep1Toml: rejects insecure (HTTP) or malformed service endpoints", () => {
  const endpointKeys = [
    "TRANSFER_SERVER",
    "TRANSFER_SERVER_SEP0024",
    "WEB_AUTH_ENDPOINT",
    "KYC_SERVER",
    "DIRECT_PAYMENT_SERVER",
    "ANCHOR_QUOTE_SERVER",
  ];

  for (const key of endpointKeys) {
    const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"
${key} = "http://insecure-server.example"

${VALID_DOC_TABLE}
`;
    assert.throws(
      () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
      (err) =>
        err instanceof Sep1DiscoveryError &&
        err.code === "INVALID_DATA" &&
        err.message.includes(key),
    );
  }
});

test("parseSep1Toml: rejects SIGNING_KEY when empty or whitespace-only", () => {
  const toml = `
NETWORK_PASSPHRASE = "Test Passphrase"
SIGNING_KEY = "   "

${VALID_DOC_TABLE}
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "INVALID_DATA" &&
      err.message.includes("SIGNING_KEY"),
  );
});

test("parseSep1Toml: rejects CURRENCIES when defined as non-array table", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[CURRENCIES]
code = "USD"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "INVALID_DATA" &&
      err.message.includes("CURRENCIES"),
  );
});

test("parseSep1Toml: rejects CURRENCIES item missing required code", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[[CURRENCIES]]
issuer = "GABC123"
status = "live"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "MISSING_REQUIRED_DATA" &&
      err.message.includes("code"),
  );
});

test("parseSep1Toml: rejects CURRENCIES item with empty or whitespace-only code", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[[CURRENCIES]]
code = "   "
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "MISSING_REQUIRED_DATA" &&
      err.message.includes("code"),
  );
});

test("parseSep1Toml: rejects CURRENCIES item with non-boolean is_asset_anchored", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[[CURRENCIES]]
code = "USD"
is_asset_anchored = "true"
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "INVALID_DATA" &&
      err.message.includes("is_asset_anchored"),
  );
});

test("parseSep1Toml: rejects CURRENCIES item with empty or non-string status", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[[CURRENCIES]]
code = "USD"
status = "   "
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "INVALID_DATA" &&
      err.message.includes("status"),
  );
});

test("parseSep1Toml: rejects CURRENCIES item with empty or non-string issuer", () => {
  const toml = `
${VALID_MINIMAL_TOML}

[[CURRENCIES]]
code = "USD"
issuer = "   "
`;
  assert.throws(
    () => parseSep1Toml(toml, "https://anchor.example/stellar.toml"),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "INVALID_DATA" &&
      err.message.includes("issuer"),
  );
});

// ---------------------------------------------------------------------------
// 4. Oversized Response Handling & Stream Boundaries
// ---------------------------------------------------------------------------

test("fetchSep1Toml: rejects Content-Length exceeding 100,000 bytes before consuming body", async () => {
  let bodyConsumed = false;

  const fetcher = (async () => {
    const res = new Response(VALID_MINIMAL_TOML, {
      status: 200,
      headers: { "Content-Length": "100001" },
    });

    const origBody = res.body;
    if (origBody) {
      Object.defineProperty(res, "body", {
        get() {
          bodyConsumed = true;
          return origBody;
        },
      });
    }

    return res;
  }) as typeof fetch;

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher }),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "RESPONSE_TOO_LARGE" &&
      err.message.includes("100000 bytes"),
  );

  assert.equal(bodyConsumed, false);
});

test("fetchSep1Toml: accepts Content-Length equal to exactly 100,000 bytes", async () => {
  const padding = " ".repeat(100_000 - VALID_MINIMAL_TOML.length);
  const exactToml = VALID_MINIMAL_TOML + padding;

  const fetcher = (async () =>
    new Response(exactToml, {
      status: 200,
      headers: { "Content-Length": "100000" },
    })) as typeof fetch;

  const result = await fetchSep1Toml("anchor.example", { fetcher });
  assert.equal(result.data.organizationName, "Valid Anchor Organization");
});

test("fetchSep1Toml: rejects streamed body exceeding 100,000 bytes when Content-Length is absent", async () => {
  const chunk1 = new TextEncoder().encode("a".repeat(50_000));
  const chunk2 = new TextEncoder().encode("b".repeat(50_001));

  const fetcher = (async () =>
    new Response(createByteStream([chunk1, chunk2]), {
      status: 200,
    })) as typeof fetch;

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher }),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      err.code === "RESPONSE_TOO_LARGE",
  );
});

// ---------------------------------------------------------------------------
// 5. Non-UTF8 & Binary Content Handling
// ---------------------------------------------------------------------------

test("fetchSep1Toml: handles stream containing non-UTF8 invalid byte sequences", async () => {
  // Invalid UTF-8 bytes: 0xFF, 0xFE, 0xC0, 0xAF (overlong or invalid byte sequences)
  const invalidUtf8Bytes = new Uint8Array([
    0x4e, 0x45, 0x54, 0x57, 0x4f, 0x52, 0x4b, 0x5f, // NETWORK_
    0xff, 0xfe, 0xc0, 0xaf,                         // invalid UTF-8 bytes
    0x3d, 0x22, 0x50, 0x75, 0x62, 0x6c, 0x69, 0x63, // ="Public
  ]);

  const fetcher = (async () =>
    new Response(createByteStream([invalidUtf8Bytes]), {
      status: 200,
    })) as typeof fetch;

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher }),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      (err.code === "INVALID_TOML" || err.code === "INVALID_DATA"),
  );
});

test("fetchSep1Toml: rejects binary payload with null bytes disguised as stellar.toml", async () => {
  const binaryPayload = new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
  ]);

  const fetcher = (async () =>
    new Response(createByteStream([binaryPayload]), {
      status: 200,
    })) as typeof fetch;

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher }),
    (err) =>
      err instanceof Sep1DiscoveryError &&
      (err.code === "INVALID_TOML" || err.code === "INVALID_DATA"),
  );
});
