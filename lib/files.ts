import { accessSync, constants as fsConstants } from "node:fs";

export function readable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
