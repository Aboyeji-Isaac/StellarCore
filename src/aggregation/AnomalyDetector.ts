import { Observation, SourceAuthority } from '../types';

/**
 * Represents the quarantine status of an observation
 */
export enum QuarantineStatus {
  NONE = 'NONE',
  OUTLIER = 'OUTLIER',
  COLLUSION_SUSPECT = 'COLLUSION_SUSPECT',
  SPARSE_DATA = 'SPARSE_DATA'
}

export interface QuarantinedObservation extends Observation {
  quarantineStatus: QuarantineStatus;
  quarantineReason: string;
  quarantinedAt: Date;
}

/**
 * Configuration for anomaly detection
 */
export interface AnomalyDetectorConfig {
  /** Maximum allowed deviation from median (as decimal, e.g., 0.1 = 10%) */
  maxDeviationFromMedian: number;
  /** Minimum number of independent sources required for anomaly detection */
  minIndependentSources: number;
  /** Threshold for collusion detection (number of sources agreeing on outlier) */
  collusionThreshold: number;
}

const DEFAULT_CONFIG: AnomalyDetectorConfig = {
  maxDeviationFromMedian: 0.2, // 20% deviation
  minIndependentSources: 3,
  collusionThreshold: 2
};

/**
 * Detects anomalies in cross-source rate observations
 */
export class AnomalyDetector {
  private config: AnomalyDetectorConfig;

  constructor(config: Partial<AnomalyDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyzes a set of observations and returns quarantined observations
   * @param observations Array of observations to analyze
   * @param authorityMap Map of source IDs to their authority levels
   * @returns Array of quarantined observations
   */
  detectAnomalies(
    observations: Observation[],
    authorityMap: Map<string, SourceAuthority>
  ): QuarantinedObservation[] {
    if (observations.length < this.config.minIndependentSources) {
      return observations.map(obs => ({
        ...obs,
        quarantineStatus: QuarantineStatus.SPARSE_DATA,
        quarantineReason: `Insufficient independent sources (${observations.length} < ${this.config.minIndependentSources})`,
        quarantinedAt: new Date()
      }));
    }

    const quarantined: QuarantinedObservation[] = [];
    const validObservations = observations.filter(obs => !obs.quarantineStatus);

    if (validObservations.length < this.config.minIndependentSources) {
      return quarantined;
    }

    // Calculate median of valid observations
    const sortedRates = [...validObservations]
      .sort((a, b) => a.rate - b.rate)
      .map(obs => obs.rate);
    
    const median = this.calculateMedian(sortedRates);
    const iqr = this.calculateIQR(sortedRates);

    // Detect outliers based on median and IQR
    for (const obs of validObservations) {
      const deviation = Math.abs(obs.rate - median) / median;
      
      if (deviation > this.config.maxDeviationFromMedian) {
        // Check for potential collusion
        const similarOutliers = validObservations.filter(
          o => Math.abs(o.rate - obs.rate) / obs.rate < 0.01 // 1% similarity
        );

        if (similarOutliers.length >= this.config.collusionThreshold) {
          quarantined.push({
            ...obs,
            quarantineStatus: QuarantineStatus.COLLUSION_SUSPECT,
            quarantineReason: `Potential collusion detected with ${similarOutliers.length} similar outliers`,
            quarantinedAt: new Date()
          });
        } else {
          quarantined.push({
            ...obs,
            quarantineStatus: QuarantineStatus.OUTLIER,
            quarantineReason: `Rate deviates by ${(deviation * 100).toFixed(2)}% from median (${median})`,
            quarantinedAt: new Date()
          });
        }
      }
    }

    return quarantined;
  }

  /**
   * Checks if an observation should be quarantined
   */
  shouldQuarantine(
    observation: Observation,
    contemporaneousObservations: Observation[],
    authorityMap: Map<string, SourceAuthority>
  ): QuarantinedObservation | null {
    const allObservations = [...contemporaneousObservations, observation];
    const quarantined = this.detectAnomalies(allObservations, authorityMap);
    
    return quarantined.find(o => o.id === observation.id) || null;
  }

  private calculateMedian(sortedValues: number[]): number {
    const length = sortedValues.length;
    if (length === 0) return 0;
    
    const mid = Math.floor(length / 2);
    if (length % 2 === 0) {
      return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
    }
    return sortedValues[mid];
  }

  private calculateIQR(sortedValues: number[]): number {
    const q1 = this.calculatePercentile(sortedValues, 25);
    const q3 = this.calculatePercentile(sortedValues, 75);
    return q3 - q1;
  }

  private calculatePercentile(sortedValues: number[], percentile: number): number {
    const pos = (sortedValues.length - 1) * percentile / 100;
    const base = Math.floor(pos);
    const rest = pos - base;
    
    if (sortedValues[base + 1] !== undefined) {
      return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
    } else {
      return sortedValues[base];
    }
  }
}
