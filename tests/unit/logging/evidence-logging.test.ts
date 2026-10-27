import { describe, it, expect, vi } from 'vitest';
import { logEvidenceEvent } from '@/lib/logging/evidence-logger';
import { logger } from '@/lib/logger';

vi.mock('@/lib/logger');

describe('Evidence Logging Classification', () => {
  it('logs expected empty results without flagging as operational failures', () => {
    logEvidenceEvent('fetch_evidence', { status: 'empty', source: 'stellar_horizon' });
    
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Evidence fetch returned empty'),
      expect.objectContaining({
        category: 'EXPECTED_EMPTY',
        source: 'stellar_horizon'
      })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('retains actionable categories for operational failures', () => {
    logEvidenceEvent('fetch_evidence', { status: 'error', errorId: 'ERR_TIMEOUT' });
    
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Evidence fetch failed'),
      expect.objectContaining({
        category: 'OPERATIONAL_FAILURE',
        errorId: 'ERR_TIMEOUT'
      })
    );
  });

  it('sanitizes sensitive payloads and credentials from error logs', () => {
    logEvidenceEvent('fetch_evidence', { 
      status: 'error', 
      payload: { auth_token: 'secret123', data: 'public' } 
    });
    
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        payload: expect.objectContaining({ auth_token: 'secret123' })
      })
    );
  });
});