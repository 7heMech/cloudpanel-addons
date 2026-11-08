// Shared by the root action and the manager, so it imports nothing.

/** `8.4` is newer than `8.3`: the one ordering the Panel PHP picker and `set-panel-php` both use. */
export function newerPhp(a: string, b: string): boolean {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor !== bMajor ? aMajor > bMajor : aMinor > bMinor;
}
