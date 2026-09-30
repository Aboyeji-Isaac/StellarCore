import net from "node:net";
import url from "node:url";

/**
 * Stable, specific error reasons for hostname validation failures.
 */
export type HostnameValidationReason =
  | "EMPTY_INPUT"
  | "WHITESPACE"
  | "LEADING_DOT"
  | "EMPTY_LABEL"
  | "MULTIPLE_TRAILING_DOTS"
  | "INVALID_SURROGATE_OR_CONTROL"
  | "FULLWIDTH_DISALLOWED"
  | "PORT_OR_PATH_OR_USERINFO"
  | "DISALLOWED_CHARACTERS"
  | "IP_LITERAL"
  | "UNDERSCORE_DISALLOWED"
  | "LABEL_TOO_SHORT"
  | "LABEL_TOO_LONG"
  | "LABEL_HYPHEN_VIOLATION"
  | "NAME_TOO_LONG"
  | "INSUFFICIENT_LABELS"
  | "NUMERIC_TLD_DISALLOWED"
  | "TLD_TOO_SHORT"
  | "INVALID_PUNYCODE"
  | "INVALID_IDNA"
  | "DISALLOWED_CODEPOINT"
  | "MIXED_SCRIPT_CONFUSABLE"
  | "CONFUSABLE_HOMOGLYPH";

export type CanonicalHostnameResult =
  | Readonly<{ ok: true; hostname: string }>
  | Readonly<{ ok: false; reason: HostnameValidationReason; message: string }>;

export class HostnameValidationError extends Error {
  readonly code: HostnameValidationReason;
  readonly reason: HostnameValidationReason;
  readonly hostname?: string;

  constructor(reason: HostnameValidationReason, message: string, hostname?: string) {
    super(message);
    this.name = "HostnameValidationError";
    this.code = reason;
    this.reason = reason;
    this.hostname = hostname;
  }
}

const FULLWIDTH_REGEX = /[\uFF01-\uFF5E\uFF61-\uFF9F\u3002\uFF0E]/;
const CONTROL_OR_SURROGATE = /[\u0000-\u001F\u007F-\u009F]|[\uD800-\uDFFF]/;
const WHITESPACE_REGEX = /\s/;
const PORT_PATH_USERINFO = /[:/?#@\\\[\]]/;
const DISALLOWED_SYMBOLS = /[\p{Extended_Pictographic}\p{Symbol}\p{Other}]/u;

// Cyrillic letters that are exact homoglyphs of basic Latin lowercase letters:
// а (U+0430), с (U+0441), е (U+0435), о (U+043E), р (U+0440),
// ѕ (U+0455), і (U+0456), ј (U+0458), у (U+0443), х (U+0445)
const CYRILLIC_LATIN_HOMOGLYPHS = /^[асеорѕіјух0-9-]+$/u;

// Greek letters that are homoglyphs of basic Latin lowercase letters:
// ο (U+03BF), ν (U+03BD), ρ (U+03C1)
const GREEK_LATIN_HOMOGLYPHS = /^[ονορ0-9-]+$/u;

/**
 * Validates and converts any supported hostname representation (ASCII or IDN)
 * to its single canonical form:
 * - Lowercase ASCII / A-label (punycode) representation
 * - Single trailing dot stripped
 * - Strictly validated against DNS/IDNA syntax and security policies
 * - Fails closed on ambiguous, malformed, confusable, or disallowed forms
 */
export function canonicalizeHostname(input: unknown): CanonicalHostnameResult {
  if (typeof input !== "string") {
    return fail("EMPTY_INPUT", "Hostname must be a non-empty string");
  }

  if (input === "" || input.trim() === "") {
    return fail("EMPTY_INPUT", "Hostname cannot be empty");
  }

  if (WHITESPACE_REGEX.test(input)) {
    return fail("WHITESPACE", "Hostname cannot contain whitespace");
  }

  if (input.startsWith(".")) {
    return fail("LEADING_DOT", "Hostname cannot begin with a dot");
  }

  if (input.endsWith("..")) {
    return fail("MULTIPLE_TRAILING_DOTS", "Hostname cannot end with multiple dots");
  }

  // Strip exactly one trailing dot to produce canonical FQDN-agnostic form
  let raw = input;
  if (raw.endsWith(".")) {
    raw = raw.slice(0, -1);
  }

  if (raw === "") {
    return fail("EMPTY_INPUT", "Hostname cannot be empty");
  }

  if (raw.includes("..")) {
    return fail("EMPTY_LABEL", "Hostname cannot contain empty labels");
  }

  if (CONTROL_OR_SURROGATE.test(raw)) {
    return fail(
      "INVALID_SURROGATE_OR_CONTROL",
      "Hostname contains invalid control characters or surrogates",
    );
  }

  if (FULLWIDTH_REGEX.test(raw)) {
    return fail(
      "FULLWIDTH_DISALLOWED",
      "Full-width characters are disallowed to prevent visual spoofing",
    );
  }

  const unbracketed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (net.isIP(unbracketed) !== 0 || /^\d+\.\d+\.\d+\.\d+$/.test(raw)) {
    return fail("IP_LITERAL", "IP literals are disallowed; hostnames must be domain names");
  }

  if (PORT_PATH_USERINFO.test(raw)) {
    return fail(
      "PORT_OR_PATH_OR_USERINFO",
      "Bare hostname cannot contain ports, paths, query, fragments, brackets, or userinfo",
    );
  }

  if (raw.includes("_")) {
    return fail("UNDERSCORE_DISALLOWED", "Underscores are not permitted in hostnames");
  }

  // Unicode normalization (NFC) as specified by UTS #46
  const normalized = raw.normalize("NFC");

  // Convert to ASCII / Punycode using Node's built-in UTS #46 processor
  let ascii: string;
  try {
    ascii = url.domainToASCII(normalized);
  } catch {
    return fail("INVALID_IDNA", "Failed to convert hostname to ASCII via IDNA UTS #46");
  }

  if (!ascii || ascii === "") {
    return fail("INVALID_IDNA", "Invalid IDNA hostname");
  }

  ascii = ascii.toLowerCase();
  if (ascii.endsWith(".")) {
    ascii = ascii.slice(0, -1);
  }

  if (Buffer.byteLength(ascii, "ascii") > 253) {
    return fail("NAME_TOO_LONG", "Hostname exceeds maximum DNS length of 253 octets");
  }

  const labels = ascii.split(".");
  if (labels.length < 2) {
    return fail("INSUFFICIENT_LABELS", "Hostname must have at least two labels");
  }

  for (const label of labels) {
    if (label.length === 0) {
      return fail("EMPTY_LABEL", "Hostname cannot contain empty labels");
    }
    if (label.length > 63) {
      return fail("LABEL_TOO_LONG", "Hostname label exceeds maximum length of 63 octets");
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return fail("LABEL_HYPHEN_VIOLATION", "Hostname label cannot begin or end with a hyphen");
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return fail("DISALLOWED_CHARACTERS", "Hostname label contains disallowed characters");
    }
  }

  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld)) {
    return fail("NUMERIC_TLD_DISALLOWED", "Top-level domain cannot be purely numeric");
  }
  if (tld.length < 2) {
    return fail("TLD_TOO_SHORT", "Top-level domain must be at least two characters");
  }

  // Punycode decoding and Unicode-level security checks
  let unicode: string;
  try {
    unicode = url.domainToUnicode(ascii);
  } catch {
    return fail("INVALID_PUNYCODE", "Punycode decoding failed");
  }

  if (!unicode || unicode === "") {
    return fail("INVALID_PUNYCODE", "Punycode decoding produced empty result");
  }

  const unicodeLabels = unicode.split(".");
  if (unicodeLabels.length !== labels.length) {
    return fail("INVALID_PUNYCODE", "Mismatch between ASCII and Unicode label counts");
  }

  for (let i = 0; i < labels.length; i++) {
    const aLabel = labels[i];
    const uLabel = unicodeLabels[i];

    if (aLabel.startsWith("xn--")) {
      // Punycode label must decode to non-ASCII characters
      if (aLabel === uLabel) {
        return fail("INVALID_PUNYCODE", "Punycode label did not decode to Unicode characters");
      }

      // Re-encode to ensure deterministic round-trip
      let reEncoded: string;
      try {
        reEncoded = url.domainToASCII(uLabel).toLowerCase();
      } catch {
        return fail("INVALID_PUNYCODE", "Punycode label failed re-encoding round-trip");
      }

      if (reEncoded !== aLabel) {
        return fail("INVALID_PUNYCODE", "Punycode label failed round-trip verification");
      }
    }

    // Check for disallowed symbols / emojis / control code points in Unicode label
    if (DISALLOWED_SYMBOLS.test(uLabel)) {
      return fail("DISALLOWED_CODEPOINT", "Hostname label contains disallowed symbols or pictographs");
    }

    // IDNA2008 check: label cannot start with a combining mark
    if (/^\p{Mark}/u.test(uLabel)) {
      return fail("DISALLOWED_CODEPOINT", "Hostname label cannot start with a combining mark");
    }

    // Script classification
    const hasLatin = /\p{Script=Latin}/u.test(uLabel);
    const hasCyrillic = /\p{Script=Cyrillic}/u.test(uLabel);
    const hasGreek = /\p{Script=Greek}/u.test(uLabel);
    const hasArabic = /\p{Script=Arabic}/u.test(uLabel);
    const hasHebrew = /\p{Script=Hebrew}/u.test(uLabel);
    const hasHan = /\p{Script=Han}/u.test(uLabel);
    const hasOtherScript = /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Han}\p{Number}\p{Punctuation}\p{Mark}]/u.test(uLabel);

    // Rule 1: Latin letters must not be mixed with any other script in the same label
    if (hasLatin && (hasCyrillic || hasGreek || hasArabic || hasHebrew || hasHan || hasOtherScript)) {
      return fail(
        "MIXED_SCRIPT_CONFUSABLE",
        "Label mixes Latin script with other scripts, creating confusable lookalikes",
      );
    }

    // Rule 2: Multiple non-Latin scripts cannot be mixed in the same label
    const scriptCount = [hasCyrillic, hasGreek, hasArabic, hasHebrew, hasHan, hasOtherScript].filter(Boolean).length;
    if (scriptCount > 1) {
      return fail("MIXED_SCRIPT_CONFUSABLE", "Label mixes multiple distinct scripts");
    }

    // Rule 3: Whole-script confusable protection for Latin lookalikes
    if (hasCyrillic && CYRILLIC_LATIN_HOMOGLYPHS.test(uLabel)) {
      return fail(
        "CONFUSABLE_HOMOGLYPH",
        "Label consists entirely of Cyrillic homoglyphs mimicking Latin text",
      );
    }

    if (hasGreek && GREEK_LATIN_HOMOGLYPHS.test(uLabel)) {
      return fail(
        "CONFUSABLE_HOMOGLYPH",
        "Label consists entirely of Greek homoglyphs mimicking Latin text",
      );
    }
  }

  return Object.freeze({ ok: true, hostname: ascii });
}

/**
 * Validates and canonicalizes a hostname, returning the canonical string
 * or throwing a HostnameValidationError.
 */
export function validateCanonicalHostname(input: unknown): string {
  const result = canonicalizeHostname(input);
  if (!result.ok) {
    throw new HostnameValidationError(
      result.reason,
      result.message,
      typeof input === "string" ? input : undefined,
    );
  }
  return result.hostname;
}

/**
 * Boolean helper indicating if a hostname is valid and canonicalizable.
 */
export function isValidHostname(input: unknown): boolean {
  return canonicalizeHostname(input).ok;
}

function fail(
  reason: HostnameValidationReason,
  message: string,
): CanonicalHostnameResult {
  return Object.freeze({ ok: false, reason, message });
}
