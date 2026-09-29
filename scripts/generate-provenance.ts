import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

const PROVENANCE_FILE = 'stellar-core-v${process.env.VERSION}-provenance.intoto.json';

function generateProvenance() {
  try {
    // Generate provenance using cosign
    execSync(`
      cosign generate \
        --type slsa \
        --predicate ${PROVENANCE_FILE} \
        --output signature \
        --key env://COSIGN_PRIVATE_KEY
    `, {
      stdio: 'inherit',
      env: { ...process.env, COSIGN_EXPERIMENTAL: 'true' }
    });
    console.log(`✓ Provenance generated: ${PROVENANCE_FILE}`);
  } catch (error) {
    console.error('✗ Provenance generation failed:', error);
    process.exit(1);
  }
}

generateProvenance();