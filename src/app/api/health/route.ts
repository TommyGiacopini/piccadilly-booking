import { prisma } from "@/server/db/prisma";
import { getAppEnvironment } from "@/shared/config/app-environment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type DatabaseHealthCheck = () => Promise<unknown>;

export async function createHealthResponse(
  checkDatabase: DatabaseHealthCheck = () => prisma.$queryRaw`SELECT 1`,
): Promise<Response> {
  let databaseAvailable = true;

  try {
    await checkDatabase();
  } catch {
    databaseAvailable = false;
  }

  return Response.json(
    {
      status: databaseAvailable ? "ok" : "degraded",
      service: "piccadilly-booking",
      environment: getAppEnvironment(),
      database: databaseAvailable ? "ok" : "unavailable",
    },
    {
      status: databaseAvailable ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function GET(): Promise<Response> {
  return createHealthResponse();
}
