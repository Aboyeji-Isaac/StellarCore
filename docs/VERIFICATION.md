# Local Artifact Verification

## Prerequisites
- Install [syft](https://github.com/anchore/syft)
- Install [cosign](https://github.com/sigstore/cosign)
- Install [spdx-tools](https://github.com/spdx/spdx-tools)

## Steps

1. **Download Artifacts**
   ```bash
   wget https://github.com/Aboyeji-Isaac/StellarCore/releases/download/v{version}/stellar-core-v{version}-sbom.spdx.json
   wget https://github.com/Aboyeji-Isaac/StellarCore/releases/download/v{version}/stellar-core-v{version}-provenance.intoto.json
   ```

2. **Verify SBOM**
   ```bash
   spdx-sbom-verify stellar-core-v{version}-sbom.spdx.json
   ```

3. **Verify Provenance**
   ```bash
   cosign verify-attachment --type slsa stellar-core-v{version}-provenance.intoto.json
   ```

4. **Check Lockfile Digest**
   ```bash
   # Compare with expected digest from release notes
   ```

## Expected Output
- SBOM verification: `Valid SPDX SBOM`
- Provenance verification: `Signature and payload verified`

## Troubleshooting
- **Missing Tools**: Ensure all prerequisites are installed.
- **Signature Errors**: Verify the public key used for signing.
- **Digest Mismatch**: Rebuild artifacts if lockfile changed.