import { AggregationPipeline } from '../AggregationPipeline';
import { Observation, SourceAuthority, QuarantineStatus } from '../../types';

describe('AggregationPipeline', () => {
  const createObservation = (rate: number, sourceId: string = 'source1'): Observation => ({
    id: `obs-${Math.random().toString(36).substring(2, 9)}`,
    sourceId,
    assetPair: 'XLM/USD',
    rate,
    timestamp: new Date(),
    rawData: { original: rate },
    normalizedAt: new Date(),
    authority: SourceAuthority.TIER_1
  });

  const authorityMap = new Map<string, SourceAuthority>([
    ['source1', SourceAuthority.TIER_1],
    ['source2', SourceAuthority.TIER_1],
    ['source3', SourceAuthority.TIER_2],
    ['source4', SourceAuthority.TIER_3]
  ]);

  describe('Basic Aggregation', () => {
    it('should calculate median from valid observations', () => {
      const pipeline = new AggregationPipeline();
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.1, 'source2'),
        createObservation(1.2, 'source3')
      ];

      const result = pipeline.aggregate(observations, authorityMap);
      
      expect(result.medianRate).toBe(1.1);
      expect(result.observationsUsed).toBe(3);
      expect(result.quarantinedObservations.length).toBe(0);
    });

    it('should exclude quarantined observations from aggregation', () => {
      const pipeline = new AggregationPipeline({ maxDeviationFromMedian: 0.1 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        createObservation(1.02, 'source3'),
        createObservation(1.5, 'source4') // Will be quarantined
      ];

      const result = pipeline.aggregate(observations, authorityMap);
      
      expect(result.observationsUsed).toBe(3);
      expect(result.quarantinedObservations.length).toBe(1);
      expect(result.quarantinedObservations[0].sourceId).toBe('source4');
      // Median should be from the 3 valid observations
      expect(result.medianRate).toBeCloseTo(1.01);
    });

    it('should throw when no valid observations remain after quarantine', () => {
      const pipeline = new AggregationPipeline({ maxDeviationFromMedian: 0.1 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.5, 'source2'),
        createObservation(2.0, 'source3')
      ];

      expect(() => pipeline.aggregate(observations, authorityMap)).toThrow(
        'No valid observations available for aggregation'
      );
    });
  });

  describe('Publishable Checks', () => {
    it('should return true for non-quarantined observations', () => {
      const pipeline = new AggregationPipeline();
      
      const observation = createObservation(1.0, 'source1');
      const contemporaneous = [
        createObservation(1.01, 'source2'),
        createObservation(1.02, 'source3')
      ];

      const isPublishable = pipeline.isPublishable(observation, contemporaneous, authorityMap);
      
      expect(isPublishable).toBe(true);
    });

    it('should return false for quarantined observations', () => {
      const pipeline = new AggregationPipeline({ maxDeviationFromMedian: 0.1 });
      
      const observation = createObservation(1.5, 'source1');
      const contemporaneous = [
        createObservation(1.0, 'source2'),
        createObservation(1.01, 'source3'),
        createObservation(1.02, 'source4')
      ];

      const isPublishable = pipeline.isPublishable(observation, contemporaneous, authorityMap);
      
      expect(isPublishable).toBe(false);
    });
  });

  describe('Provenance Preservation', () => {
    it('should preserve raw data in quarantined observations', () => {
      const pipeline = new AggregationPipeline({ maxDeviationFromMedian: 0.1 });
      const rawData = { original: 1.5, metadata: { provider: 'test' } };
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        { ...createObservation(1.5, 'source3'), rawData }
      ];

      const result = pipeline.aggregate(observations, authorityMap);
      
      expect(result.quarantinedObservations.length).toBe(1);
      expect(result.quarantinedObservations[0].rawData).toEqual(rawData);
    });

    it('should include quarantine reason in quarantined observations', () => {
      const pipeline = new AggregationPipeline({ maxDeviationFromMedian: 0.1 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        createObservation(1.5, 'source3')
      ];

      const result = pipeline.aggregate(observations, authorityMap);
      
      expect(result.quarantinedObservations[0].quarantineReason).toContain('deviates');
      expect(result.quarantinedObservations[0].quarantineReason).toContain('median');
    });
  });

  describe('Authority Semantics', () => {
    it('should respect source authority from #122', () => {
      // This test verifies that the authority map is properly used
      const customAuthorityMap = new Map<string, SourceAuthority>([
        ['source1', SourceAuthority.TIER_1],
        ['source2', SourceAuthority.TIER_3] // Lower authority
      ]);

      const pipeline = new AggregationPipeline();
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.1, 'source2')
      ];

      // With only 2 sources, should quarantine due to sparse data
      const result = pipeline.aggregate(observations, customAuthorityMap);
      
      expect(result.quarantinedObservations.length).toBe(2);
      expect(result.quarantinedObservations.every(
        o => o.quarantineStatus === QuarantineStatus.SPARSE_DATA
      )).toBe(true);
    });
  });
});
