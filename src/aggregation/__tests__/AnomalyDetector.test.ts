import { AnomalyDetector, QuarantineStatus } from '../AnomalyDetector';
import { Observation, SourceAuthority } from '../../types';

describe('AnomalyDetector', () => {
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

  describe('Outlier Detection', () => {
    it('should quarantine observations deviating significantly from median', () => {
      const detector = new AnomalyDetector({ maxDeviationFromMedian: 0.1 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        createObservation(1.02, 'source3'),
        createObservation(1.5, 'source4') // 50% deviation
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      
      expect(quarantined.length).toBe(1);
      expect(quarantined[0].quarantineStatus).toBe(QuarantineStatus.OUTLIER);
      expect(quarantined[0].sourceId).toBe('source4');
    });

    it('should not quarantine observations within deviation threshold', () => {
      const detector = new AnomalyDetector({ maxDeviationFromMedian: 0.2 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.05, 'source2'),
        createObservation(1.1, 'source3'),
        createObservation(1.15, 'source4')
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      
      expect(quarantined.length).toBe(0);
    });
  });

  describe('Collusion Detection', () => {
    it('should detect potential collusion among similar outliers', () => {
      const detector = new AnomalyDetector({
        maxDeviationFromMedian: 0.1,
        collusionThreshold: 2
      });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        createObservation(1.5, 'source3'),
        createObservation(1.505, 'source4') // Similar to source3
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      
      expect(quarantined.length).toBe(2);
      expect(quarantined.every(o => o.quarantineStatus === QuarantineStatus.COLLUSION_SUSPECT)).toBe(true);
    });
  });

  describe('Sparse Data Handling', () => {
    it('should quarantine all observations when below minimum source threshold', () => {
      const detector = new AnomalyDetector({ minIndependentSources: 3 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.1, 'source2')
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      
      expect(quarantined.length).toBe(2);
      expect(quarantined.every(o => o.quarantineStatus === QuarantineStatus.SPARSE_DATA)).toBe(true);
    });

    it('should not quarantine when meeting minimum source threshold', () => {
      const detector = new AnomalyDetector({ minIndependentSources: 3 });
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.05, 'source2'),
        createObservation(1.1, 'source3')
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      
      expect(quarantined.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty observation list', () => {
      const detector = new AnomalyDetector();
      const quarantined = detector.detectAnomalies([], authorityMap);
      expect(quarantined.length).toBe(0);
    });

    it('should preserve original observation data in quarantined observations', () => {
      const detector = new AnomalyDetector({ maxDeviationFromMedian: 0.1 });
      const rawData = { original: 1.5, metadata: { provider: 'test' } };
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        { ...createObservation(1.5, 'source3'), rawData }
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      
      expect(quarantined.length).toBe(1);
      expect(quarantined[0].rawData).toEqual(rawData);
    });

    it('should include timestamp in quarantined observations', () => {
      const detector = new AnomalyDetector({ maxDeviationFromMedian: 0.1 });
      const beforeDetection = new Date();
      
      const observations = [
        createObservation(1.0, 'source1'),
        createObservation(1.01, 'source2'),
        createObservation(1.5, 'source3')
      ];

      const quarantined = detector.detectAnomalies(observations, authorityMap);
      const afterDetection = new Date();
      
      expect(quarantined.length).toBe(1);
      expect(quarantined[0].quarantinedAt.getTime()).toBeGreaterThanOrEqual(beforeDetection.getTime());
      expect(quarantined[0].quarantinedAt.getTime()).toBeLessThanOrEqual(afterDetection.getTime());
    });
  });
});
