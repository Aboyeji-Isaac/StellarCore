import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

const SBOM_FILE = 'stellar-core-v${process.env.VERSION}-sbom.spdx.json';

function generateSBOM() {
  try {
    // Generate SBOM using syft
    execSync('syft dir:. -o spdx-json > ${SBOM_FILE}', {
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' }
    });
    console.log(`✓ SBOM generated: ${SBOM_FILE}`);
  } catch (error) {
    console.error('✗ SBOM generation failed:', error);
    process.exit(1);
  }
}

generateSBOM();