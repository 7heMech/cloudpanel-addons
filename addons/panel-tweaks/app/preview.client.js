(function () {
  function syncTheme() {
    var dark = /(?:^|;\s*)theme=dark(?:;|$)/.test(document.cookie);
    try {
      if (parent !== window) dark = parent.document.documentElement.classList.contains('dark');
    } catch (e) {}
    document.documentElement.classList.toggle('dark', dark);
  }
  syncTheme();
  try {
    if (parent !== window) new MutationObserver(syncTheme).observe(parent.document.documentElement, {
      attributes: true, attributeFilter: ['class']
    });
  } catch (e) {}
})();
