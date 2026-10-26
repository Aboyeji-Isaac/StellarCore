export type PublicApiHttpResult = Readonly<{ status: number; body: unknown }>;

export function publicApiJsonResponse(
  result: PublicApiHttpResult,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
