import { Observation, QuarantinedObservation, QuarantineStatus } from '../types';
import { AnomalyDetector } from './AnomalyDetector';
import { SourceAuthority } from '../types/SourceAuthority';

export interface AggregationResult {
  assetPair: string;
  medianRate: number;
  observationsUsed: number;
  quarantinedObservations: QuarantinedObservation[];
  timestamp: Date;
}

export class AggregationPipeline {
  private anomalyDetector: AnomalyDetector;

  constructor(anomalyDetectorConfig?: Partial<AnomalyDetector['config']>) {
    this.anomalyDetector = new AnomalyDetector(anomalyDetectorConfig);
  }

  /**
   * Aggregates observations for a given asset pair
   * @param observations All observations for the asset pair
   * @param authorityMap Map of source IDs to their authority levels
   * @returns Aggregation result with quarantined observations excluded
   */
  aggregate(
    observations: Observation[],
    authorityMap: Map<string, SourceAuthority>
  ): AggregationResult {
    // First pass: detect anomalies
    const quarantined = this.anomalyDetector.detectAnomalies(observations, authorityMap);
    const quarantinedIds = new Set(quarantined.map(o => o.id));

    // Filter out quarantined observations for aggregation
    const validObservations = observations.filter(obs => !quarantinedIds.has(obs.id));

    if (validObservations.length === 0) {
      throw new Error('No valid observations available for aggregation');
    }

    // Calculate median from valid observations
    const sortedRates = [...validObservations]
      .sort((a, b) => a.rate - b.rate)
      .map(obs => obs.rate);

    const median = this.calculateMedian(sortedRates);

    return {
      assetPair: observations[0].assetPair,
      medianRate: median,
      observationsUsed: validObservations.length,
      quarantinedObservations: quarantined,
      timestamp: new Date()
    };
  }

  /**
   * Checks if an observation meets the publishable threshold
   * @param observation The observation to check
   * @param contemporaneousObservations Other observations for the same asset pair at similar time
   * @param authorityMap Source authority map
   * @returns boolean indicating if observation can be published
   */
  isPublishable(
    observation: Observation,
    contemporaneousObservations: Observation[],
    authorityMap: Map<string, SourceAuthority>
  ): boolean {
    const allObservations = [...contemporaneousObservations, observation];
    const quarantined = this.anomalyDetector.detectAnomalies(allObservations, authorityMap);
    const isQuarantined = quarantined.some(o => o.id === observation.id);
    
    return !isQuarantined;
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
}
