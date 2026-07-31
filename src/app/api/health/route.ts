import { getAppEnvironment } from "@/shared/config/app-environment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "piccadilly-booking",
      environment: getAppEnvironment(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
