(function () {
  // One listener on the document rather than one per link: the Sites rows are
  // the panel's, and a filtered or re-sorted table moves them around. Without
  // this script the link still opens the terminal, in the same tab.
  document.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("a.clp-terminal-open") : null;
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    clpOpenTerminal("ADDON_URL", link.getAttribute("data-clp-domain"), event.shiftKey);
  });
})();
