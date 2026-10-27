export type StaleEvidenceMetadata = Readonly<{
  state: "stale";
  generatedAt: string;
  expiresAt: string;
  sourceTimes: readonly string[];
  snapshotAgeMs: number;
}>;
