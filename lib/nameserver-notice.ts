import { CLIPBOARD } from "./clipboard";
import STYLE from "./assets/nameserver-notice.css" with { type: "text" };
import BODY from "./assets/nameserver-notice.client.js" with { type: "text" };

/** Defines `clpNameserverNotice(alert, zone, nameServers, next)` for a script on a CloudPanel page. */
export const NAMESERVER_NOTICE_JS = `var clpNameserverAssets = ${JSON.stringify({ style: STYLE, clipboard: CLIPBOARD })};\n${BODY}`;
