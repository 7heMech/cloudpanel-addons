import { expect, test } from "bun:test";
import OPEN_JS from "../addons/terminal/app/open.client.js" with { type: "text" };

test("each site's terminal opens separately and repeated clicks reuse only that site", () => {
  for (const phone of [false, true]) {
    const targets = new Map<string, { location: { href: string }; focus: () => void; focuses: number }>();
    const window = {
      matchMedia: () => ({ matches: phone }),
      open(url: string, name: string) {
        let target = targets.get(name);
        if (!target) {
          target = { location: { href: "about:blank" }, focuses: 0, focus() { this.focuses++; } };
          targets.set(name, target);
        }
        if (url) target.location.href = url;
        return target;
      },
    };
    const open = new Function("window", `${OPEN_JS}\nreturn clpOpenTerminal;`)(window);
    open("/addons/terminal", "a-b.example.com", false);
    open("/addons/terminal", "a.b.example.com", false);
    expect(targets.size).toBe(2);
    const [hyphen, dot] = [...targets.values()];
    expect(hyphen!.location.href).toBe("/addons/terminal/sites/a-b.example.com");
    expect(dot!.location.href).toBe("/addons/terminal/sites/a.b.example.com");

    open("/addons/terminal", "a-b.example.com", false);
    expect(targets.size).toBe(2);
    expect(hyphen!.focuses).toBe(2);
    expect(dot!.focuses).toBe(1);
    open("/addons/terminal", "A-B.EXAMPLE.COM", false);
    expect(targets.size).toBe(2);
    expect(hyphen!.focuses).toBe(3);

    open("/addons/terminal", "a-b.example.com", true);
    expect(targets.size).toBe(3);
    expect([...targets.values()][2]!.location.href).toBe("/addons/terminal/sites/a-b.example.com");
    expect(hyphen!.focuses).toBe(3);
  }
});
