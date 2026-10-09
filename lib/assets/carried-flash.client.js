
function reloadWithFlash(key, message, kind) {
  try { sessionStorage.setItem(key, JSON.stringify({ message: message, kind: kind })); } catch (e) {}
  location.reload();
}

function showCarriedFlash(key) {
  let carried = null;
  try {
    carried = sessionStorage.getItem(key);
    if (carried) sessionStorage.removeItem(key);
  } catch (e) { return; }
  if (!carried) return;
  try {
    const flash = JSON.parse(carried);
    notify(flash.message, flash.kind);
  } catch (e) {}
}
