import vercelConfiguration from "../vercel.json";
import { auditCronCadenceConfiguration } from "@/lib/config/cronCadence";

export async function main(): Promise<void> {
  try {
    const { auditCurrentStellarCoreConfiguration } = await import(
      "@/lib/config/currentStellarCoreConfiguration"
    );
    const registryResult = auditCurrentStellarCoreConfiguration();
    const cronResult = auditCronCadenceConfiguration(vercelConfiguration);
    const issues = Object.freeze([...registryResult.issues, ...cronResult.issues]);
    const ok = registryResult.ok && cronResult.ok;

    process.stdout.write(`${JSON.stringify({
      ok,
      issueCount: issues.length,
      issues,
    })}\n`);

    if (!ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      issueCount: 1,
      issues: [{
        code: "CONFIGURATION_LOAD_FAILURE",
        registry: "configuration",
      }],
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
