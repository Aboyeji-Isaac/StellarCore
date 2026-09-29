import { execSync } from 'child_process';
import { readFileSync } from 'fs';

function verifyArtifact() {
  const version = process.env.VERSION;
  const sbomFile = `stellar-core-v${version}-sbom.spdx.json`;
  const provenanceFile = `stellar-core-v${version}-provenance.intoto.json`;

  // Verify SBOM integrity
  execSync(`spdx-sbom-verify ${sbomFile}`, {
    stdio: 'inherit'
  });

  // Verify provenance
  execSync(`cosign verify-attachment --type slsa ${provenanceFile}`, {
    stdio: 'inherit'
  });

  console.log('✓ Artifact verification successful.');
}

verifyArtifact();