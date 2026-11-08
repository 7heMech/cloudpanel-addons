// Plain ES5: inlined into the addons' page script and into Panel Tweaks' script
// on CloudPanel's own Sites page, so both keep one copy.
//
// With a mouse, a select's list is drawn like the menus (appearance:
// base-select), and a select drawn that way is as wide as its chosen option
// rather than its widest, so choosing one would move whatever sits beside it.
// Each is given its widest option's width as a minimum, which a native select
// has anyway, capped at the window's width less a margin so none can run off a
// narrow one. Not at its container's: a container as wide as its contents
// would make that a loop, and the minimum would be ignored. The width is the
// options' text measured on a canvas in the select's own font, plus its
// padding and border: no layout is forced, a select not yet drawn (in a closed
// <details>) is held like any other, and it is worked out again when its
// options change or a web font arrives.
var clpSelectCanvas = null;

function clpHoldSelectWidth(select) {
  var style = getComputedStyle(select);
  if (style.appearance !== "base-select") {
    if (select.getAttribute("data-clp-width")) {
      select.style.minWidth = "";
      select.removeAttribute("data-clp-width");
    }
    return;
  }
  if (!clpSelectCanvas) clpSelectCanvas = document.createElement("canvas").getContext("2d");
  if (!clpSelectCanvas) return;
  clpSelectCanvas.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
  var widest = 0;
  for (var i = 0; i < select.options.length; i++) {
    widest = Math.max(widest, clpSelectCanvas.measureText(select.options[i].label).width);
  }
  if (style.boxSizing === "border-box") {
    widest += parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  }
  var held = "min(" + Math.ceil(widest) + "px, 100vw - 32px)";
  if (select.getAttribute("data-clp-width") === held) return;
  select.setAttribute("data-clp-width", held);
  select.style.minWidth = held;
}

// Holds every select under root now, again when a web font arrives, and, with
// watch, whenever a select or its options are added or changed under root.
function clpHoldSelectWidths(root, watch) {
  if (typeof getComputedStyle !== "function" || !root || !root.querySelectorAll) return;
  function all() {
    var list = root.querySelectorAll("select");
    for (var i = 0; i < list.length; i++) clpHoldSelectWidth(list[i]);
  }
  all();
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", all);
  if (!watch || typeof MutationObserver !== "function") return;
  // Called before the next paint, so a select never draws at its old width.
  new MutationObserver(function (records) {
    var seen = [];
    function take(select) {
      if (select && seen.indexOf(select) === -1) seen.push(select);
    }
    for (var r = 0; r < records.length; r++) {
      var target = records[r].target;
      var element = target.nodeType === 1 ? target : target.parentNode;
      if (element && element.closest) take(element.closest("select"));
      var added = records[r].addedNodes;
      for (var a = 0; a < added.length; a++) {
        var node = added[a];
        if (node.nodeType !== 1) continue;
        if (node.tagName === "SELECT") take(node);
        else if (node.querySelectorAll) {
          var inside = node.querySelectorAll("select");
          for (var s = 0; s < inside.length; s++) take(inside[s]);
        }
      }
    }
    for (var i = 0; i < seen.length; i++) clpHoldSelectWidth(seen[i]);
  }).observe(root, { childList: true, subtree: true, characterData: true });
}
