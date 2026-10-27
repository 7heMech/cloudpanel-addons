// Copies each column's heading onto its cells, for the narrow-screen cards in
// site-tables.css. It names rows while the page is still being parsed, so the
// labels are there by the time the cards are painted.
(function () {
  function name() {
    var rows = document.querySelectorAll(".site-content .card-table table.table:not(.table-sites) > tbody > tr");
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var head = row.closest("table").tHead;
      if (!head || !head.rows.length) continue;
      for (var c = 0; c < row.cells.length; c++) {
        var th = head.rows[0].cells[c];
        if (th && !row.cells[c].hasAttribute("data-label")) row.cells[c].setAttribute("data-label", th.textContent.trim());
      }
    }
  }
  var observer = new MutationObserver(name);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", function () {
    observer.disconnect();
    name();
  });
})();
