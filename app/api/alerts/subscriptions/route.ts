import {
  createAlertSubscription,
  deleteAlertSubscription,
  getAlertSubscription,
  listAlertSubscriptionsByCorridor,
} from "@/lib/api/alertSubscriptions";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "missing_corridor", message: "Invalid JSON body." } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await createAlertSubscription(body);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const corridor = url.searchParams.get("corridor");

  if (id) {
    const result = await getAlertSubscription(id);
    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (corridor) {
    const result = await listAlertSubscriptionsByCorridor(corridor);
    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return Response.json(
    {
      error: {
        code: "missing_corridor",
        message: "Either id or corridor parameter is required.",
      },
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  const result = await deleteAlertSubscription(id);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
