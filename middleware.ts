import { NextResponse } from "next/server";

import { enforcePublicRateLimit } from "@/lib/ratelimit/enforce";

// Public read APIs only. /api/internal/* (cron) is excluded here and again
// inside enforcePublicRateLimit.
export async function middleware(request: Request): Promise<Response> {
  return (await enforcePublicRateLimit(request)) ?? NextResponse.next();
}

export const config = {
  matcher: ["/api/((?!internal/).*)"],
};
