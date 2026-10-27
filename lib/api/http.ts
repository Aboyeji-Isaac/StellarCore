export type PublicApiHttpResult = Readonly<{ status: number; body: unknown }>;

export function clientDisconnectedResponse(): Response {
  return new Response(null, {
    status: 499,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function respondUnlessRequestAborted(
  request: Request,
  operation: () => Promise<Response>,
): Promise<Response> {
  if (request.signal.aborted) return clientDisconnectedResponse();

  try {
    const response = await operation();
    return request.signal.aborted ? clientDisconnectedResponse() : response;
  } catch (error) {
    if (request.signal.aborted) return clientDisconnectedResponse();
    throw error;
  }
}

export function publicApiJsonResponse(
  result: PublicApiHttpResult,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
