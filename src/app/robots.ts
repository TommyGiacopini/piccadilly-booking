import type { MetadataRoute } from "next";

import { getAppEnvironment } from "@/shared/config/app-environment";

export default function robots(): MetadataRoute.Robots {
  if (getAppEnvironment() === "staging") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return { rules: { userAgent: "*", allow: "/" } };
}
