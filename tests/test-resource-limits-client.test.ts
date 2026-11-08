import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TWEAK_ROW_JS } from "../lib/app-ui";

function resourceMemoryClient() {
  // As the page has it: working() is shared, in TWEAK_ROW_JS.
  const source = TWEAK_ROW_JS + ["memory.client.js", "views.client.js"].map((name) => readFileSync(join(import.meta.dir, "../addons/resource-limits/app", name), "utf8")).join("\n");
  const events: string[] = [];
  const replies: { path: string; body: string; answer: (body: unknown) => void }[] = [];
  const lines: { textContent: string; removed: boolean }[] = [];
  const row = {
    querySelector: () => ({ after: (line: { textContent: string }) => events.push(`working: ${line.textContent}`) }),
  };
  const control = (label: string) => ({
    dataset: {} as Record<string, string>, type: "checkbox", checked: true, id: "",
    getAttribute: () => label, closest: (selector: string) => (selector === ".tweak-row" ? row : null),
  });
  const document = {
    createElement: () => {
      const line = { textContent: "", removed: false, className: "", innerHTML: "", setAttribute() {},
        append(text: string) { line.textContent += text; }, remove() { line.removed = true; } };
      lines.push(line);
      return line;
    },
  };
  const client = new Function("call", "busy", "notify", "clearNotice", "repaintView", "CLP_ROOT", "clpFlashTimer", "document",
    `function paintFleetSelection() {}\n${source}\nreturn { setMemory };`)(
    (path: string, options: { body: string }) => new Promise((answer) => {
      events.push(`POST ${path} ${options.body}`);
      replies.push({ path, body: options.body, answer });
    }),
    (on: boolean) => events.push(on ? "busy" : "idle"),
    (message: string, kind: string) => events.push(`${kind}: ${message}`),
    () => {},
    (_holder: unknown, html: string) => events.push(`repaint: ${html}`),
    { getElementById: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
    0,
    document,
  ) as Record<"setMemory", (control: unknown) => Promise<void>>;
  return { client, control, events, replies, lines };
}

test("MySQL sizing keeps progress visible until the reply and explains that a restart is still needed", async () => {
  for (const checked of [true, false]) {
    const { client, control, events, replies, lines } = resourceMemoryClient();
    const input = { ...control("Size MySQL to this server"), dataset: { setting: "memory-mysql" }, checked };
    const pending = client.setMemory(input);
    await Bun.sleep(0);
    expect(replies.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/api/memory", body: JSON.stringify({ mysql: checked }) },
    ]);
    expect(events).toContain(checked ? "working: Saving and checking MySQL sizes…" : "working: Restoring CloudPanel’s MySQL sizes…");
    expect(events).not.toContain("idle");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.removed).toBe(false);
    replies[0]!.answer({ ok: true, html: "<p>Pending restart</p>" });
    await pending;
    expect(lines[0]!.removed).toBe(true);
    expect(events.slice(-3)).toEqual([
      "repaint: <p>Pending restart</p>", "idle",
      checked ? "ok: Saved. MySQL uses these sizes at its next restart." : "ok: Saved. CloudPanel’s MySQL sizes return at its next restart.",
    ]);
  }
});
