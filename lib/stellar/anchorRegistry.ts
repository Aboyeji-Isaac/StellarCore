import type { AnchorRegistryEntry } from "@/types/anchor";
import {
  type DomainControlVerificationResult,
  type VerificationDependencies,
  verifyProof,
  verifyProofAsync,
} from "@/lib/stellar/domainControl";
import { getAnchorProof } from "@/constants/anchorProofs";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOME_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidHomeDomain(homeDomain: string): boolean {
  return HOME_DOMAIN_PATTERN.test(homeDomain);
}

export type AnchorRegistryValidationIssue = Readonly<{
  slug: string;
  code: "INVALID_SLUG" | "EMPTY_NAME" | "INVALID_HOME_DOMAIN" | "DUPLICATE_SLUG" | "DUPLICATE_HOME_DOMAIN" | "MISSING_DOMAIN_CONTROL_PROOF" | "INVALID_DOMAIN_CONTROL_PROOF";
  message: string;
  proofVerification?: DomainControlVerificationResult;
}>;

export type AnchorRegistryValidationResult = Readonly<{
  ok: boolean;
  issues: readonly AnchorRegistryValidationIssue[];
}>;

export function validateAnchorRegistry(
  entries: readonly AnchorRegistryEntry[],
): void {
  const result = validateAnchorRegistryDetailed(entries);
  if (!result.ok) {
    const messages = result.issues.map((issue) => issue.message);
    throw new Error(`Anchor registry validation failed:\n${messages.join("\n")}`);
  }
}

export function validateAnchorRegistryDetailed(
  entries: readonly AnchorRegistryEntry[],
): AnchorRegistryValidationResult {
  const issues: AnchorRegistryValidationIssue[] = [];
  const slugs = new Set<string>();
  const homeDomains = new Set<string>();

  for (const entry of entries) {
    if (!SLUG_PATTERN.test(entry.slug)) {
      issues.push({
        slug: entry.slug,
        code: "INVALID_SLUG",
        message: `Invalid anchor slug: "${entry.slug}"`,
      });
      continue;
    }

    if (!entry.name.trim()) {
      issues.push({
        slug: entry.slug,
        code: "EMPTY_NAME",
        message: `Anchor "${entry.slug}" has an empty name`,
      });
      continue;
    }

    if (!isValidHomeDomain(entry.homeDomain)) {
      issues.push({
        slug: entry.slug,
        code: "INVALID_HOME_DOMAIN",
        message: `Anchor "${entry.slug}" has an invalid home domain: "${entry.homeDomain}"`,
      });
      continue;
    }

    if (slugs.has(entry.slug)) {
      issues.push({
        slug: entry.slug,
        code: "DUPLICATE_SLUG",
        message: `Duplicate anchor slug: "${entry.slug}"`,
      });
      continue;
    }

    if (homeDomains.has(entry.homeDomain)) {
      issues.push({
        slug: entry.slug,
        code: "DUPLICATE_HOME_DOMAIN",
        message: `Duplicate anchor home domain: "${entry.homeDomain}"`,
      });
      continue;
    }

    const proof = getAnchorProof(entry.slug);
    if (!proof) {
      issues.push({
        slug: entry.slug,
        code: "MISSING_DOMAIN_CONTROL_PROOF",
        message: `Anchor "${entry.slug}" is missing a domain control proof. New anchors and homeDomain changes require a valid proof.`,
      });
      continue;
    }

    const verification = verifyProof(proof, entry, {
      clock: { now: () => new Date() },
      isNonceUsed: async () => false,
      markNonceUsed: async () => {},
    });

    if (!verification.ok) {
      issues.push({
        slug: entry.slug,
        code: "INVALID_DOMAIN_CONTROL_PROOF",
        message: `Anchor "${entry.slug}" has an invalid domain control proof: ${verification.error}`,
        proofVerification: verification,
      });
      continue;
    }

    slugs.add(entry.slug);
    homeDomains.add(entry.homeDomain);
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}

export async function validateAnchorRegistryAsync(
  entries: readonly AnchorRegistryEntry[],
  dependencies: VerificationDependencies,
): Promise<AnchorRegistryValidationResult> {
  const issues: AnchorRegistryValidationIssue[] = [];
  const slugs = new Set<string>();
  const homeDomains = new Set<string>();

  for (const entry of entries) {
    if (!SLUG_PATTERN.test(entry.slug)) {
      issues.push({
        slug: entry.slug,
        code: "INVALID_SLUG",
        message: `Invalid anchor slug: "${entry.slug}"`,
      });
      continue;
    }

    if (!entry.name.trim()) {
      issues.push({
        slug: entry.slug,
        code: "EMPTY_NAME",
        message: `Anchor "${entry.slug}" has an empty name`,
      });
      continue;
    }

    if (!isValidHomeDomain(entry.homeDomain)) {
      issues.push({
        slug: entry.slug,
        code: "INVALID_HOME_DOMAIN",
        message: `Anchor "${entry.slug}" has an invalid home domain: "${entry.homeDomain}"`,
      });
      continue;
    }

    if (slugs.has(entry.slug)) {
      issues.push({
        slug: entry.slug,
        code: "DUPLICATE_SLUG",
        message: `Duplicate anchor slug: "${entry.slug}"`,
      });
      continue;
    }

    if (homeDomains.has(entry.homeDomain)) {
      issues.push({
        slug: entry.slug,
        code: "DUPLICATE_HOME_DOMAIN",
        message: `Duplicate anchor home domain: "${entry.homeDomain}"`,
      });
      continue;
    }

    const proof = getAnchorProof(entry.slug);
    if (!proof) {
      issues.push({
        slug: entry.slug,
        code: "MISSING_DOMAIN_CONTROL_PROOF",
        message: `Anchor "${entry.slug}" is missing a domain control proof. New anchors and homeDomain changes require a valid proof.`,
      });
      continue;
    }

    const verification = await verifyProofAsync(proof, entry, dependencies);

    if (!verification.ok) {
      issues.push({
        slug: entry.slug,
        code: "INVALID_DOMAIN_CONTROL_PROOF",
        message: `Anchor "${entry.slug}" has an invalid domain control proof: ${verification.error}`,
        proofVerification: verification,
      });
      continue;
    }

    slugs.add(entry.slug);
    homeDomains.add(entry.homeDomain);
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}

export function requiresDomainControlProof(
  existingEntry: AnchorRegistryEntry | undefined,
  newEntry: AnchorRegistryEntry,
): boolean {
  if (!existingEntry) {
    return true;
  }
  return existingEntry.homeDomain !== newEntry.homeDomain;
}