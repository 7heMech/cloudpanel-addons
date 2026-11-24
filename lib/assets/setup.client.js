// The Setup header link on an administrator's addon pages. The tab keeps
// whether it was showing, and with Action needed, so the header does not shift
// before /addons/api/setup answers.
const CLP_SETUP_KEY = 'clp-setup-shown';
const CLP_SETUP_URL = '/addons/api/setup';

function clpSetupShow(shown, attention) {
  const chip = document.getElementById('clp-setup-chip');
  const nav = document.getElementById('clp-setup-nav');
  if (!chip) return;
  const active = chip.getAttribute('aria-current') === 'page';
  [chip, nav].forEach(function (link) {
    if (!link) return;
    link.hidden = !shown && !active;
    link.classList.toggle('clp-setup-attention', Boolean(attention));
  });
  const reopen = document.getElementById('clp-addons-setup-btn');
  if (reopen) reopen.hidden = Boolean(shown);
  try {
    if (shown) sessionStorage.setItem(CLP_SETUP_KEY, attention ? 'attention' : '1');
    else sessionStorage.removeItem(CLP_SETUP_KEY);
  } catch (error) {}
}

(function () {
  const chip = document.getElementById('clp-setup-chip');
  if (!chip) return;
  if (chip.getAttribute('aria-current') === 'page') return;
  let known = null;
  try { known = sessionStorage.getItem(CLP_SETUP_KEY); } catch (error) {}
  if (known) clpSetupShow(true, known === 'attention');
  fetch(CLP_SETUP_URL, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (reply) {
      if (reply && reply.ok && reply.data) clpSetupShow(reply.data.show, reply.data.attention);
      else if (known) clpSetupShow(false, false);
    })
    .catch(function () { if (known) clpSetupShow(false, false); });
})();
