import { NextResponse, type NextRequest } from "next/server";

import {
  createStagingUnauthorizedResponse,
  isAuthorizedForStaging,
  isStagingAccessExempt,
  STAGING_ROBOTS_HEADER,
} from "@/server/staging/access-gate";
import { getAppEnvironment } from "@/shared/config/app-environment";

export function proxy(request: NextRequest): Response {
  if (getAppEnvironment() !== "staging") return NextResponse.next();

  if (
    !isStagingAccessExempt(request.nextUrl.pathname) &&
    !isAuthorizedForStaging(request.headers.get("authorization"))
  ) {
    return createStagingUnauthorizedResponse();
  }

  const response = NextResponse.next();
  response.headers.set("X-Robots-Tag", STAGING_ROBOTS_HEADER);
  return response;
}

export const config = {
  matcher: "/:path*",
};
