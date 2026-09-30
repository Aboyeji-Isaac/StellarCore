# Hostname Canonicalization & IDNA Security Policy

## Overview

StellarCore interacts with anchor services and endpoints across untrusted network boundaries (registry declarations, SEP-1 TOML discovery, SEP-10 authentication endpoints, SEP-38 quote servers, and Stellar authentication tokens). To prevent spoofing, duplicate detection bypass, allowlist circumvention, and homoglyph attacks across internationalized domain names (IDNs), all hostnames and home domains are validated and canonicalized through a single module: [`lib/stellar/hostname.ts`](file:///c:/Users/USER/Desktop/DRIPS/StellarCore/lib/stellar/hostname.ts).

## The Canonical Form

Every valid hostname resolves to exactly one canonical representation:
1. **Lowercase ASCII / A-Label (Punycode)**: Any internationalized Unicode domain (U-label) is transformed into its standard ASCII-compatible encoding (A-label starting with `xn--`) and normalized to lowercase.
2. **Single Trailing Dot Stripped**: In DNS notation, a single trailing dot denotes a fully-qualified domain name (FQDN). To ensure unambiguous string comparisons between DNS entries and HTTP URL representations, a single trailing dot is stripped. Multiple trailing dots are rejected.
3. **No Redundant or Inconsistent Representations**: All security boundaries, duplicate checks, and persistence layers store and compare hostnames exclusively in this canonical ASCII form.

Examples:
- `example.com.` -> `example.com`
- `EXAMPLE.COM` -> `example.com`
- `münchen.de` -> `xn--mnchen-3ya.de`
- `XN--MNCHEN-3YA.DE.` -> `xn--mnchen-3ya.de`
- `café.com` (NFC or NFD) -> `xn--caf-dma.com`

## Standard IDNA Approach & Library Choice

We utilize Node 22's built-in UTS #46 processing (`url.domainToASCII` and `url.domainToUnicode`, backed by the engine's integrated ICU library) paired with strict pre- and post-processing validation at the security boundary.

**Rationale for using Node 22 built-ins rather than a new dependency:**
- **Zero Supply-Chain Risk**: Avoids introducing third-party runtime dependencies for security-critical parsing.
- **Engine Alignment**: `package.json` specifies `"engines": { "node": "22.x" }`; Node 22's built-in ICU is maintained directly as part of Node.js LTS with official Unicode consortium tables and security patches.
- **Strict Hardening**: Standard `domainToASCII` defaults allow certain permissive behaviors (such as mapping full-width characters or permitting underscores). Our canonicalization wrapper fails closed on ambiguous, confusable, or disallowed inputs before and after IDNA transformation.

## Unicode Policy

1. **Pre-normalization**: Unicode inputs are normalized to Unicode Normal Form C (NFC) prior to transformation, ensuring composed and decomposed sequences resolve identically.
2. **Deterministic Round-Trip**: Any punycode A-label (`xn--...`) must decode to non-ASCII Unicode characters and re-encode to the exact original ASCII label.
3. **Rejection over Silent Normalization**: Any input that cannot be safely, deterministically, and unambiguously validated fails closed rather than being silently coerced.

## Disallowed & Rejected Categories

The canonicalizer returns a typed failure (`{ ok: false, reason, message }`) for the following categories:

| Reason Code | Description |
| --- | --- |
| `EMPTY_INPUT` | Empty string or whitespace-only input |
| `WHITESPACE` | Input containing leading, trailing, or internal whitespace |
| `LEADING_DOT` | Hostname starting with a dot (e.g. `.example.com`) |
| `EMPTY_LABEL` | Empty label within the domain (e.g. `example..com`) |
| `MULTIPLE_TRAILING_DOTS` | More than one trailing dot (e.g. `example.com..`) |
| `INVALID_SURROGATE_OR_CONTROL` | Null bytes, ASCII control characters (0x00–0x1F, 0x7F), or unpaired surrogates |
| `FULLWIDTH_DISALLOWED` | Full-width or compatibility characters (`\uFF01-\uFF5E`, `\u3002`, `\uFF0E`) to prevent visual spoofing |
| `PORT_OR_PATH_OR_USERINFO` | Bare hostname containing `:`, `/`, `\`, `?`, `#`, `@`, or brackets |
| `UNDERSCORE_DISALLOWED` | Underscores (`_`) are prohibited in DNS hostnames |
| `IP_LITERAL` | IPv4 or IPv6 literals (e.g. `127.0.0.1`, `::1`, `[::1]`) |
| `LABEL_TOO_SHORT` | Label length is 0 octets |
| `LABEL_TOO_LONG` | Label length exceeds 63 octets |
| `LABEL_HYPHEN_VIOLATION` | Label starting or ending with a hyphen (e.g. `-foo.com`, `foo-.com`) |
| `NAME_TOO_LONG` | Total canonical hostname exceeds 253 octets |
| `INSUFFICIENT_LABELS` | Hostname with fewer than 2 labels (bare TLDs or localhost disallowed) |
| `NUMERIC_TLD_DISALLOWED` | Top-level domain is purely numeric |
| `TLD_TOO_SHORT` | Top-level domain is shorter than 2 characters |
| `INVALID_PUNYCODE` | Punycode label that fails decoding, is ASCII-only in `xn--`, or fails round-trip |
| `INVALID_IDNA` | Input that fails UTS #46 conversion |
| `DISALLOWED_CODEPOINT` | Code points prohibited in hostnames (emojis, pictographs, symbols, leading combining marks) |
| `MIXED_SCRIPT_CONFUSABLE` | Label mixing Latin with other scripts (Cyrillic, Greek, Arabic, Hebrew, etc.) |
| `CONFUSABLE_HOMOGLYPH` | Whole-script non-Latin label consisting entirely of Latin lookalikes |

## Confusable Detection Strategy & Known Limitations

### Strategy
1. **Single-Script per Label Rule**: Under Unicode Technical Standard #39, labels containing Latin script characters (`\p{Script=Latin}`) must not mix with characters from any other script (Cyrillic, Greek, Arabic, Hebrew, Han, etc.).
2. **Whole-Script Latin Homoglyph Protection**: Specific non-Latin scripts contain characters visually indistinguishable from Latin lowercase letters (e.g. Cyrillic `а, с, е, о, р, ѕ, і, ј, у, х` or Greek `ο, ν, ρ`). Non-Latin labels composed entirely of these homoglyphs are rejected to prevent impersonation of Latin domain names.
3. **Symbol & Emoji Prohibition**: Pictographs, emojis, and symbols are rejected.

### Known Limitations
- **Intra-Script Lookalikes**: Visual lookalikes within the same script (such as Latin lowercase `l`, digit `1`, and uppercase `I`, or `vv` vs `w`) cannot be distinguished algorithmically without an external dictionary of known brands.
- **Cross-Script Non-Latin Spoofs**: Homoglyph attacks between two non-Latin scripts (e.g. Cyrillic lookalikes of Greek letters) are not exhaustively cataloged beyond our mixed-script and Latin-homoglyph rules.
- **Legitimate Internationalized Domains**: Non-Latin labels with mixed non-Latin scripts or containing non-Latin characters outside the Latin-homoglyph block are permitted as valid IDNs when they satisfy single-script constraints.

## Migrated Boundaries

Every hostname and home domain boundary in StellarCore now routes through `lib/stellar/hostname.ts`:
1. **Anchor Registry Validation** (`lib/stellar/anchorRegistry.ts`):
   - `isValidHomeDomain(homeDomain)` delegates directly to `isValidHostname`.
   - `validateAnchorRegistry(entries)` canonicalizes each `homeDomain` before duplicate detection, ensuring case, trailing-dot, or punycode variants cannot bypass uniqueness.
2. **SEP-1 Discovery** (`lib/stellar/sep1.ts`):
   - `buildSep1TomlUrl(homeDomain)` validates and canonicalizes the domain before constructing the HTTPS TOML URL.
   - `discoverAnchor(entry)` ensures the returned anchor metadata contains the canonical `homeDomain`.
3. **SEP-10 Web Authentication** (`lib/stellar/sep10.ts`):
   - `normalizeSep10AuthEndpoint(endpoint)` canonicalizes `url.hostname` and removes trailing dots.
   - `normalizeConfig(config)` canonicalizes `homeDomain` and `clientDomain`.
   - Challenge verification (`validateSep10Challenge`, `matchesWebAuthDomainOperation`, `matchesClientDomainOperation`) operates strictly over canonical hostnames.
4. **SEP-38 Quote Server Normalization** (`lib/stellar/sep38.ts`):
   - `normalizeSep38QuoteServer(quoteServer)` canonicalizes `url.hostname`.
5. **Stellar Authentication Token Parsing** (`lib/stellar/auth.ts`):
   - `validateIssuer(value)` validates issuer URL hostnames with canonicalization.
   - `parseStellarAuthToken`, `validateStellarAuthToken`, and `validateMetadata` store and compare canonical `homeDomain`.
6. **Anchor Synchronization** (`lib/stellar/anchorSync.ts`):
   - `persistDiscoveredAnchor(anchor)` ensures the persisted `homeDomain` in the database is canonical.
