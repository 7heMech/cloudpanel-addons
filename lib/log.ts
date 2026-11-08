export function paint(code: string, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  return stream.isTTY && stream.hasColors(16) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

let redrawing = false;
const endRedraw = () => {
  if (redrawing) process.stdout.write("\n");
  redrawing = false;
};

export type OnProgress = (progress: string, done: boolean) => void;

export const log = {
  step: (m: string) => { endRedraw(); console.log(`${paint("2", "›")} ${m}`); },
  ok: (m: string) => { endRedraw(); console.log(`${paint("32", "✓")} ${m}`); },
  warn: (m: string) => { endRedraw(); console.warn(`${paint("33", "!", process.stderr)} ${m}`); },
  err: (m: string) => { endRedraw(); console.error(`${paint("31", "✗", process.stderr)} ${m}`); },
  plain: (m = "") => { endRedraw(); console.log(m); },
  progress: (m: string, done: boolean) => {
    if (!process.stdout.isTTY || process.env.TERM === "dumb") {
      if (done) log.step(m);
      return;
    }
    process.stdout.write(`\r\x1b[K${paint("2", "›")} ${m}`);
    redrawing = !done;
    if (done) process.stdout.write("\n");
  },
};

export class Fatal extends Error {}

export function fatal(message: string): never {
  throw new Fatal(message);
}

export function requireRoot(verb: string, why = "modifies system state"): void {
  if (process.getuid?.() !== 0) {
    fatal(`'${verb}' ${why} and must run as root`);
  }
}
