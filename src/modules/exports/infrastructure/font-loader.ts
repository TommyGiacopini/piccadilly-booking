import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const notoSansPath = join(
  process.cwd(),
  "assets",
  "fonts",
  "noto-sans",
  "NotoSans[wdth,wght].ttf",
);

let fontPromise: Promise<Buffer> | null = null;

export function loadNotoSansFont(): Promise<Buffer> {
  fontPromise ??= readFile(notoSansPath);
  return fontPromise;
}

export function notoSansFontPath(): string {
  return notoSansPath;
}
