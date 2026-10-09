// One window per site, named after it, so a second click focuses the shell
// already open instead of starting another. Opened inside the click, before
// anything is awaited: a window opened later is a popup the browser blocks.
// Plain ES5, because CloudPanel's own pages run it too.
function clpOpenTerminal(base, domain, fresh) {
  var url = base + "/sites/" + encodeURIComponent(domain);
  var name = "clp-terminal-" + encodeURIComponent(domain.toLowerCase()) + (fresh ? "-" + Date.now().toString(36) : "");
  // A phone has no windows, only tabs.
  var phone = window.matchMedia && window.matchMedia("(max-width: 760px) and (pointer: coarse)").matches;
  var target = phone ? window.open(url, name) : window.open("", name, "popup,width=980,height=620");
  if (!target) {
    alert("Allow pop-ups for the panel to open the terminal.");
    return;
  }
  if (!phone) {
    var blank = true;
    try { blank = target.location.href === "about:blank"; } catch (e) {}
    if (blank) target.location.href = url;
  }
  target.focus();
}
