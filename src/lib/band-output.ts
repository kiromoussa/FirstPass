import fs from "fs/promises";
import path from "path";

export const OUTPUT_DIR = path.join(process.cwd(), "output");

export async function outputFresh(filename: string, sinceMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(OUTPUT_DIR, filename));
    return stat.mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}
