import { z } from "zod";

const databaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;

      return protocol === "postgres:" || protocol === "postgresql:";
    } catch {
      return false;
    }
  });

export function resolveDatabaseUrl(configuredUrl: string | undefined): string {
  const result = databaseUrlSchema.safeParse(configuredUrl);

  if (!result.success) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  return result.data;
}

export function getDatabaseUrl(): string {
  return resolveDatabaseUrl(process.env.DATABASE_URL);
}
