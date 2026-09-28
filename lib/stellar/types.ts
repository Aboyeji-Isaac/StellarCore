export interface SEP1DiscoveryObservation {
  id: string;
  anchorId: string;
  observedAt: Date;
  metadata: Record<string, any>;
  digest: string;
  parserState: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SEP1ApprovedBaseline {
  id: string;
  anchorId: string;
  observationId: string;
  approvedFields: Record<string, any>;
  approvedAt: Date;
  approvedBy: string;
  reason: string;
  createdAt: Date;
}

export interface SEP1DiscoveryResult {
  metadata: {
    network_passphrase: string;
    signing_key: string;
    endpoints: Record<string, string>;
    assets: Array<{ code: string; asset_type: string }>;
  };
  success: boolean;
  error?: string;
}

export interface SEP1FieldDiff {
  [field: string]: {
    approved: any;
    observed: any;
  };
}