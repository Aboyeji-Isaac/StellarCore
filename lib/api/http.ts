import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/security/requestId";

export type PublicApiHttpResult = Readonly<{ status: number; body: unknown }>;

export function publicApiJsonResponse(
  result: PublicApiHttpResult,
  headers: Readonly<Record<string, string>> = {},
  request?: Request,
): Response {
  const responseHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    ...headers,
  };

  const existingHeaderKey = Object.keys(responseHeaders).find(
    (key) => key.toLowerCase() === REQUEST_ID_HEADER,
  );

  if (!existingHeaderKey) {
    const incomingId = request?.headers.get(REQUEST_ID_HEADER);
    responseHeaders[REQUEST_ID_HEADER] = resolveRequestId(incomingId);
  }

  return Response.json(result.body, {
    status: result.status,
    headers: responseHeaders,
  });
}
