// A single FastCGI request over a Unix socket: enough to ask a PHP-FPM pool for
// one page without going through Nginx, whose basic auth would answer first.

import { createConnection } from "node:net";

export interface FastCgiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const BEGIN_REQUEST = 1;
const END_REQUEST = 3;
const PARAMS = 4;
const STDIN = 5;
const STDOUT = 6;
const RESPONDER = 1;

function record(type: number, content: Uint8Array = new Uint8Array()): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header[1] = type;
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(content.length, 4);
  return Buffer.concat([header, content]);
}

function length(value: number): Buffer {
  if (value < 128) return Buffer.from([value]);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE((value | 0x80000000) >>> 0);
  return bytes;
}

function encodeParams(params: Record<string, string>): Buffer {
  return Buffer.concat(Object.entries(params).flatMap(([name, value]) => {
    const key = Buffer.from(name);
    const text = Buffer.from(value);
    return [length(key.length), length(text.length), key, text];
  }));
}

export function parseCgiResponse(output: string): FastCgiResponse {
  const split = output.search(/\r?\n\r?\n/);
  const head = split < 0 ? output : output.slice(0, split);
  const body = split < 0 ? "" : output.slice(split).replace(/^\r?\n\r?\n/, "");
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const status = Number(/^(\d{3})/.exec(headers.status ?? "")?.[1] ?? 200);
  return { status, headers, body };
}

export function fastCgiRequest(socket: string, params: Record<string, string>, timeoutMs = 10_000): Promise<FastCgiResponse> {
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path: socket });
    const chunks: Buffer[] = [];
    let pending = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolve(parseCgiResponse(Buffer.concat(chunks).toString("utf8")));
    };
    const timer = setTimeout(() => finish(new Error(`${socket} did not answer within ${timeoutMs / 1000}s`)), timeoutMs);

    connection.on("connect", () => {
      const begin = Buffer.alloc(8);
      begin.writeUInt16BE(RESPONDER, 0);
      connection.write(Buffer.concat([
        record(BEGIN_REQUEST, begin),
        record(PARAMS, encodeParams(params)),
        record(PARAMS),
        record(STDIN),
      ]));
    });
    connection.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 8) {
        const size = pending.readUInt16BE(4);
        const total = 8 + size + pending[6]!;
        if (pending.length < total) break;
        const type = pending[1];
        if (type === STDOUT) chunks.push(pending.subarray(8, 8 + size));
        pending = pending.subarray(total);
        if (type === END_REQUEST) return finish(null);
      }
    });
    connection.on("error", (error) => finish(error));
    connection.on("close", () => finish(new Error(`${socket} closed before the request ended`)));
  });
}
