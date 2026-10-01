import { PRISMA_SUPPRESSION_REPOSITORY } from "@/lib/scheduled/suppressionRepository";

const anchorSlug = requiredSlug(
  process.env.STELLARCORE_REACTIVATE_ANCHOR,
  "STELLARCORE_REACTIVATE_ANCHOR",
);
const corridorSlug = requiredSlug(
  process.env.STELLARCORE_REACTIVATE_CORRIDOR,
  "STELLARCORE_REACTIVATE_CORRIDOR",
);
const reason = requiredReason(process.env.STELLARCORE_REACTIVATE_REASON);

const result = await PRISMA_SUPPRESSION_REPOSITORY.reactivate({
  anchorSlug,
  corridorSlug,
  reason,
  reactivatedAt: new Date(),
});

if (!result) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      code: "SUPPRESSION_NOT_FOUND",
      anchorSlug,
      corridorSlug,
    }) + "\n",
  );
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    anchorSlug: result.anchorSlug,
    corridorSlug: result.corridorSlug,
    state: result.state,
    reactivatedAt: result.reactivatedAt,
    reactivationReason: result.reactivationReason,
  }) + "\n",
);

function requiredSlug(value: string | undefined, variable: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`${variable} must be a stable lowercase slug`);
  }
  return normalized;
}

function requiredReason(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length < 8 || normalized.length > 500) {
    throw new Error(
      "STELLARCORE_REACTIVATE_REASON must contain 8-500 reviewed characters",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("STELLARCORE_REACTIVATE_REASON contains control characters");
  }
  return normalized;
}
