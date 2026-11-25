// Copies a published release to the R2 bucket behind clp.7he.dev, which
// release.yml runs after it publishes the GitHub release.
//
//   bun tools/mirror-release.ts <tag> <dir>
//
// Needs R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
// R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, from a token limited to that bucket.
// The release's files go up before the index names them, and the index and
// `latest` before anything they no longer name is deleted.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MIRROR_INDEX, MIRROR_LATEST, parseMirrorIndex, planMirror } from "../lib/release-mirror";

const [tag, dir] = process.argv.slice(2);
if (!tag || !dir) throw new Error("usage: bun tools/mirror-release.ts <tag> <dir>");

const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set`); })();
const bucket = new Bun.S3Client({
  endpoint: env("R2_ENDPOINT"),
  bucket: env("R2_BUCKET"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
});

const typeOf = (name: string) =>
  name.endsWith(".json") ? "application/json" : /\.(sh|jsonl)$|^SHA256SUMS$/.test(name) ? "text/plain; charset=utf-8" : "application/octet-stream";

const names = readdirSync(dir).sort();
for (const name of names) {
  await bucket.write(`releases/${tag}/${name}`, Bun.file(join(dir, name)), { type: typeOf(name) });
  console.log(`uploaded releases/${tag}/${name}`);
}

const indexFile = bucket.file(MIRROR_INDEX);
const current = (await indexFile.exists()) ? parseMirrorIndex(await indexFile.json()) : [];
if (!current) throw new Error(`${MIRROR_INDEX} in the bucket is not a release list; fix or delete it`);
const plan = planMirror(current, tag, names);

await bucket.write(MIRROR_INDEX, JSON.stringify(plan.index, null, 2), { type: "application/json" });
if (plan.latest) {
  await bucket.write("install.sh", Bun.file(join(dir, "install.sh")), { type: "text/plain; charset=utf-8" });
  await bucket.write(MIRROR_LATEST, `${tag}\n`, { type: "text/plain; charset=utf-8" });
  console.log(`${tag} is the latest release`);
}

for (const release of plan.dropped) {
  for (const asset of release.assets) await bucket.delete(`releases/${release.tag_name}/${asset.name}`);
  console.log(`deleted ${release.tag_name}`);
}
