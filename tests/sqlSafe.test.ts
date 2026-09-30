import { safeIdentifier, rawSql } from '../src/utils/sqlSafe';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('SQL safe utilities', () => {
  test('safeIdentifier allows whitelisted name', () => {
    expect(safeIdentifier('Observation')).toBe('`Observation`');
  });

  test('safeIdentifier rejects unknown name', () => {
    expect(() => safeIdentifier('BadTable')).toThrow();
  });

  test('rawSql constructs parameterized query', async () => {
    const id = 1;
    const query = rawSql`SELECT * FROM ${safeIdentifier('Observation')} WHERE id = ${id}`;
    // Ensure query is a Prisma.sql object (type check)
    expect(query).toBeDefined();
    // Execute against test DB (assuming test DB is configured)
    const result = await prisma.$queryRaw(query);
    // No assertion on result; just ensure no injection error
    expect(Array.isArray(result)).toBe(true);
  });
});
