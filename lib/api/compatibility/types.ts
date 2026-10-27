export type ContractHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiDomain = "anchors" | "corridors" | "rates" | "reputation";

export type CompatibilityFixture = Readonly<{
  name: string;
  domain: ApiDomain;
  endpoint: string;
  method: ContractHttpMethod;
  expectedStatus: number;
  description: string;
  body: unknown;
}>;

export type ChangeSeverity = "breaking" | "additive";

export type CompatibilityIssue = Readonly<{
  path: string;
  severity: ChangeSeverity;
  message: string;
  expected?: unknown;
  actual?: unknown;
}>;

export type FixtureComparisonResult = Readonly<{
  fixtureName: string;
  domain: ApiDomain;
  endpoint: string;
  expectedStatus: number;
  actualStatus: number;
  ok: boolean;
  breakingIssues: readonly CompatibilityIssue[];
  additiveChanges: readonly CompatibilityIssue[];
}>;

export type ContractManifest = Readonly<{
  version: string;
  contractVersion: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewReason?: string;
  breakingChangesApproved: boolean;
  totalFixtures: number;
  fixtures: readonly Readonly<{
    name: string;
    path: string;
    sha256: string;
  }>[];
}>;

export type CompatibilityAuditSummary = Readonly<{
  ok: boolean;
  contractVersion: string;
  totalFixtures: number;
  passedFixtures: number;
  breakingCount: number;
  additiveCount: number;
  results: readonly FixtureComparisonResult[];
}>;
