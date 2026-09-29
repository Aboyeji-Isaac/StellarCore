import { execSync } from 'child_process';

function checkSecrets() {
  const secretPatterns = ['PRIVATE_KEY', 'API_TOKEN', 'PASSWORD', 'SECRET'];
  const files = ['*.spdx.json', '*.intoto.json', 'dist/**'];

  for (const file of files) {
    for (const pattern of secretPatterns) {
      try {
        execSync(`grep -r --include='${file}' '${pattern}' .`, {
          stdio: 'ignore'
        });
        console.error(`✗ Secret detected in ${file}`);
        process.exit(1);
      } catch (error) {
        // No match found, continue
      }
    }
  }
  console.log('✓ No secrets detected in artifacts.');
}

checkSecrets();