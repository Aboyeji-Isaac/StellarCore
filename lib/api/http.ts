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

export function readQueryParameter(
  parameters: URLSearchParams,
  name: string,
): string | readonly string[] | null {
  const values = parameters.getAll(name);
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  return Object.freeze(values);
}

