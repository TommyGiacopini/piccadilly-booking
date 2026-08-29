import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function implementationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return implementationFiles(absolute);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [absolute] : [];
  }));
  return nested.flat();
}

describe("M12 notification network kill gate", () => {
  it("contains no real provider, transport, external URL or provider secret implementation", async () => {
    const root = path.resolve(process.cwd(), "src/modules/notifications");
    const files = await implementationFiles(root);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    const banned = [
      /class\s+Real(?:WhatsApp|Email)Provider/u,
      /https?:\/\//u,
      /\bfetch\s*\(/u,
      /\bhttps?\.request\s*\(/u,
      /\b(?:SMTP|nodemailer|sendgrid|resend|graph\.facebook|META_ACCESS_TOKEN)\b/iu,
      /\b(?:net|tls)\.connect\s*\(/u,
    ];
    for (const pattern of banned) expect(source).not.toMatch(pattern);
  });

  it("keeps domain and application independent from infrastructure and frameworks", async () => {
    const roots = [
      path.resolve(process.cwd(), "src/modules/notifications/domain"),
      path.resolve(process.cwd(), "src/modules/notifications/application"),
    ];
    const files = (await Promise.all(roots.map(implementationFiles))).flat();
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/from\s+["'](?:@\/modules\/notifications\/infrastructure|@\/generated\/prisma|@\/server\/db|next(?:\/|["']))/u);
  });
});
