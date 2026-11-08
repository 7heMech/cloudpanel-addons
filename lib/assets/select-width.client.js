// Plain ES5: joined to the addons' page script and to Panel Tweaks' script on
// CloudPanel's own Sites page, so both keep one copy.
//
// With a mouse, a select's list is drawn like the menus (appearance:
// base-select), and a select drawn that way is as wide as its chosen option
// rather than its widest, so choosing one would move whatever sits beside it.
// Only a select as wide as its content changes: one given a width, such as a
// form's 100%, keeps it whatever is chosen and is left alone. The computed
// width says which without a layout. One as wide as its content gets its
// widest option's width as a minimum, which a native select has anyway, capped
// at the window less a margin so none can run off a narrow one (not at its
// container, which would be a loop in a container as wide as its contents).
// The width is the options' text measured on a canvas in the select's own
// font, plus its padding and border: no layout is forced, and a select not
// yet drawn (in a closed <details>) is held like any other. It is worked out
// again when its options or their labels change, when a web font arrives, and
// when a mouse comes or goes and the list is drawn the other way.
var clpSelectCanvas = null;
var clpSelectRoots = [];
var clpSelectWatch = null;

function clpSelectSizesToContent(select) {
  var map = select.computedStyleMap && select.computedStyleMap();
  return Boolean(map) && String(map.get("width")) === "auto";
}

function clpHoldSelectWidth(select) {
  var style = getComputedStyle(select);
  if (style.appearance !== "base-select" || !clpSelectSizesToContent(select)) {
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

// Only the selects themselves are watched, for options added or changed and
// labels renamed, not the page around them.
function clpWatchSelect(select) {
  if (typeof MutationObserver !== "function") return;
  if (!clpSelectWatch) {
    clpSelectWatch = new MutationObserver(function (records) {
      var seen = [];
      for (var r = 0; r < records.length; r++) {
        var target = records[r].target;
        var element = target.nodeType === 1 ? target : target.parentNode;
        var select = element && element.closest ? element.closest("select") : null;
        if (select && seen.indexOf(select) === -1) seen.push(select);
      }
      for (var i = 0; i < seen.length; i++) clpHoldSelectWidth(seen[i]);
    });
  }
  select.setAttribute("data-clp-watched", "1");
  clpSelectWatch.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["label"] });
}

function clpHoldAllSelects() {
  for (var r = 0; r < clpSelectRoots.length; r++) {
    var list = clpSelectRoots[r].querySelectorAll("select");
    for (var i = 0; i < list.length; i++) clpHoldSelectWidth(list[i]);
  }
}

// Holds and watches every select under root. A page that redraws part of
// itself calls this again for what it drew; a select added any other way is
// held when it is first reached.
function clpHoldSelectWidths(root) {
  if (typeof getComputedStyle !== "function" || !root || !root.querySelectorAll) return;
  var list = root.querySelectorAll("select");
  for (var i = 0; i < list.length; i++) {
    clpHoldSelectWidth(list[i]);
    clpWatchSelect(list[i]);
  }
  if (clpSelectRoots.indexOf(root) !== -1) return;
  if (!clpSelectRoots.length) {
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", clpHoldAllSelects);
    var mouse = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)");
    if (mouse && mouse.addEventListener) mouse.addEventListener("change", clpHoldAllSelects);
    else if (mouse && mouse.addListener) mouse.addListener(clpHoldAllSelects);
    var reached = function (event) {
      var target = event.composedPath ? event.composedPath()[0] : event.target;
      if (target && target.tagName === "SELECT" && !target.getAttribute("data-clp-watched")) {
        clpHoldSelectWidth(target);
        clpWatchSelect(target);
      }
    };
    document.addEventListener("pointerdown", reached, true);
    document.addEventListener("focusin", reached, true);
  }
  clpSelectRoots.push(root);
}
