import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";
import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import {
  assertStellarCoreConfiguration,
  auditStellarCoreConfiguration,
  type ConfigurationAuditResult,
  type StellarCoreConfigurationInput,
} from "@/lib/config/stellarCoreConfiguration";

const CURRENT_STELLARCORE_CONFIGURATION = Object.freeze({
  anchors: ANCHOR_REGISTRY,
  corridors: CORRIDOR_REGISTRY,
  anchorCorridorMappings: ANCHOR_CORRIDOR_REGISTRY,
  reviewedLiveRateSources: REVIEWED_LIVE_RATE_SOURCES,
}) satisfies StellarCoreConfigurationInput;

export function auditCurrentStellarCoreConfiguration(): ConfigurationAuditResult {
  return auditStellarCoreConfiguration(CURRENT_STELLARCORE_CONFIGURATION);
}

export function assertCurrentStellarCoreConfiguration(): ConfigurationAuditResult {
  return assertStellarCoreConfiguration(CURRENT_STELLARCORE_CONFIGURATION);
}
