import { getMaintenanceModeStatus } from "@/lib/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const status = await getMaintenanceModeStatus();
  return Response.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}