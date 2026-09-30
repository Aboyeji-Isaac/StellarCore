import { SourceAuthority } from './SourceAuthority';

export interface Observation {
  id: string;
  sourceId: string;
  assetPair: string;
  rate: number;
  timestamp: Date;
  rawData: unknown; // Preserved original observation data
  normalizedAt: Date;
  authority: SourceAuthority;
  quarantineStatus?: string; // Legacy support, prefer QuarantineStatus
}

export { QuarantineStatus, QuarantinedObservation } from '../aggregation/AnomalyDetector';
