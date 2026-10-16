let editingProfile = null;
let pendingReview = null;
function showError(message) {
  notify(message,'error');
  const dialog = CLP_ROOT.querySelector('dialog[open]');
  if (!dialog) return;
  let feedback = dialog.querySelector('[data-dialog-error]');
  if (!feedback) {
    feedback = document.createElement('div'); feedback.dataset.dialogError = ''; feedback.className = 'alert'; feedback.setAttribute('role','alert');
    dialog.querySelector('.dialog-header').after(feedback);
  }
  feedback.textContent = message; feedback.scrollIntoView({block:'nearest'});
}
function openDialog(id) {
  const dialog = CLP_ROOT.getElementById(id);
  dialog.querySelectorAll('[data-dialog-error]').forEach(function (error) { error.remove(); });
  dialog.showModal();
}
function paintSelection() {
  const selected = selectedRows();
  siteRows().forEach(function (row) { row.setAttribute('aria-selected', String(selected.includes(row))); });
  const note = CLP_ROOT.getElementById('site-selection');
  if (note) note.textContent = selected.length ? selected.length + ' selected' : 'No sites selected';
  const button = CLP_ROOT.getElementById('assign-selected');
  if (button) button.disabled = !selected.length;
  const all = CLP_ROOT.getElementById('select-all');
  if (all) { all.checked = selected.length > 0 && selected.length === siteRows().length; all.indeterminate = selected.length > 0 && !all.checked; }
}
async function change(path, body) {
  busy(true);
  let reviewDisplayed = false;
  try {
    const result = await call('/api/' + path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body || {}) });
    if (result.html) { CLP_ROOT.getElementById('domains-content').innerHTML = result.html; paintSelection(); }
    if (result.data && result.data.review) {
      reviewDisplayed = true;
      pendingReview = result.data.review;
      CLP_ROOT.getElementById('review-content').innerHTML = result.reviewHtml;
      CLP_ROOT.getElementById('apply-plan').textContent = pendingReview.removal ? 'Remove records' : 'Confirm and enforce';
      CLP_ROOT.getElementById('profile-dialog').close();
      openDialog('review-dialog');
    }
    return result;
  } catch (e) { showError(e.message); throw e; }
  finally { busy(false); if (reviewDisplayed) CLP_ROOT.getElementById('apply-plan').disabled = Boolean(pendingReview.blocked); }
}
function scanNow() { change('plan').then(function () { notify('Plan refreshed.', 'ok'); }).catch(function () {}); }
function openConnections() {
  const data = JSON.parse(CLP_ROOT.getElementById('domains-data').dataset.connections);
  const form = CLP_ROOT.getElementById('connections-form');
  form.reset(); form.elements.accountId.value = data.accountId; form.elements.mailcowUrl.value = data.mailcowUrl;
  form.elements.cloudflareToken.placeholder = data.hasCloudflareToken ? 'Saved · leave blank to keep' : 'API token';
  form.elements.mailcowKey.placeholder = data.hasMailcowKey ? 'Saved · leave blank to keep' : 'API key';
  updateCloudflareTokenLink();
  openDialog('connections-dialog');
}
function updateCloudflareTokenLink() {
  const template = JSON.parse(CLP_ROOT.getElementById('domains-data').dataset.tokenTemplate);
  const account = CLP_ROOT.getElementById('cf-account').value.trim().toLowerCase();
  const valid = /^[a-f0-9]{32}$/.test(account);
  const link = CLP_ROOT.getElementById('cf-create-token');
  CLP_ROOT.getElementById('cf-token-permissions').textContent = template.permissions.join(', ');
  CLP_ROOT.getElementById('cf-token-scope').textContent = valid ? 'Preselects all zones in this account. Review the scope in Cloudflare, create the token, then paste it above.' : 'Enter your 32-character Cloudflare account ID to enable token creation.';
  link.setAttribute('aria-disabled', String(!valid));
  if (valid) {
    const url = new URL(template.url); url.searchParams.set('accountId', account); link.href = url.href; link.removeAttribute('tabindex');
  } else { link.removeAttribute('href'); link.tabIndex = -1; }
}
async function saveConnections(event) {
  event.preventDefault();
  const form = CLP_ROOT.getElementById('connections-form');
  const body = Object.fromEntries(new FormData(form)); body.accountId = String(body.accountId).trim().toLowerCase();
  try { await change('connections', body); form.reset(); CLP_ROOT.getElementById('connections-dialog').close(); notify('Connections saved. Profiles are Report only; scan before enabling Enforce.', 'ok'); } catch (e) {}
}
function profileFrom(button) { return JSON.parse(button.closest('[data-profile]').dataset.profile); }
function lines(value) { return value.split(/[\s,]+/).map(function (v) { return v.trim(); }).filter(Boolean); }
function editProfile(button) {
  editingProfile = button ? profileFrom(button) : JSON.parse(CLP_ROOT.getElementById('domains-data').dataset.preset);
  if (!button) { editingProfile.id = ''; editingProfile.name = ''; editingProfile.mode = 'report'; }
  CLP_ROOT.querySelectorAll('[data-profile-field]').forEach(function (field) {
    const value = editingProfile[field.dataset.profileField];
    if (field.type === 'checkbox') field.checked = value; else field.value = value;
  });
  CLP_ROOT.getElementById('profile-includes').value = editingProfile.spfIncludes.join('\n');
  CLP_ROOT.getElementById('profile-spf-domains').value = Object.entries(editingProfile.spfByDomain).map(function (pair) { return pair[0] + ': ' + pair[1].join(' '); }).join('\n');
  CLP_ROOT.getElementById('profile-mainwp').value = editingProfile.mainwpIps.join('\n');
  CLP_ROOT.getElementById('profile-templates').value = JSON.stringify(editingProfile.templates,null,2);
  CLP_ROOT.getElementById('profile-title').textContent = button ? 'Edit ' + editingProfile.name : 'New profile';
  openDialog('profile-dialog');
}
async function saveProfile(event) {
  event.preventDefault();
  try {
    const profile = Object.assign({}, editingProfile);
    CLP_ROOT.querySelectorAll('[data-profile-field]').forEach(function (field) { profile[field.dataset.profileField] = field.type === 'checkbox' ? field.checked : field.dataset.profileField === 'dkimBits' ? Number(field.value) : field.value.trim(); });
    if (!profile.id) profile.id = profile.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50) + '-' + crypto.randomUUID().slice(0,8);
    profile.spfIncludes = lines(CLP_ROOT.getElementById('profile-includes').value);
    profile.mainwpIps = lines(CLP_ROOT.getElementById('profile-mainwp').value);
    profile.spfByDomain = {};
    CLP_ROOT.getElementById('profile-spf-domains').value.split('\n').filter(function (v) { return v.trim(); }).forEach(function (line) {
      const parts = line.split(':'); if (parts.length !== 2) throw new Error('Per-domain SPF uses domain: include-host include-host.');
      profile.spfByDomain[parts[0].trim()] = lines(parts[1]);
    });
    profile.templates = JSON.parse(CLP_ROOT.getElementById('profile-templates').value);
    const result = await change('profiles', profile);
    if (!result.data.review) { CLP_ROOT.getElementById('profile-dialog').close(); notify('Profile saved.', 'ok'); }
  } catch (e) { showError(e.message); }
}
function setProfileMode(button) {
  const profile = profileFrom(button); profile.mode = profile.mode === 'report' ? 'enforce' : 'report';
  change('profiles',profile).catch(function () {});
}
async function deleteProfile(button) {
  const profile = profileFrom(button);
  if (!await confirmAction({ title:'Delete profile?', text:'Sites will lose this assignment. Their DNS and Mailcow stay in place.', confirmLabel:'Delete profile' })) return;
  change('profiles/delete',{id:profile.id}).catch(function () {});
}
function assignSite(select) { change('assign',{domains:[select.closest('[data-domain]').dataset.domain],profileId:select.value || null}).catch(function () {}); }
function assignSelected() {
  const id = CLP_ROOT.getElementById('bulk-profile').value;
  if (id === 'choose') { notify('Choose a profile first.','error'); return; }
  change('assign',{domains:selectedRows().map(function (r) { return r.dataset.domain; }),profileId:id || null}).catch(function () {});
}
function changeDefault(select) { change('default',{profileId:select.value || null}).catch(function () {}); }
function removeOrphan(button) { change('remove',JSON.parse(button.closest('[data-orphan]').dataset.orphan)).catch(function () {}); }
async function applyPlan() {
  if (!pendingReview || pendingReview.blocked) return;
  try { await change('apply',{token:pendingReview.token}); CLP_ROOT.getElementById('review-dialog').close(); pendingReview = null; notify('Reviewed changes applied. Check any remaining pending changes or errors.', 'ok'); } catch (e) {}
}
function provisionSite(button) {
  change('provision',{domain:button.closest('[data-domain]').dataset.domain}).then(function (r) { notify(r.data.reason,r.data.ready ? 'ok' : 'warn'); }).catch(function () {});
}
function retrySsl(button) { change('ssl/retry',{domain:button.closest('[data-domain]').dataset.domain}).then(function () { notify('SSL retry scheduled for the next reconcile.', 'ok'); }).catch(function () {}); }
CLP_ROOT.querySelectorAll('#connections-dialog,#profile-dialog,#review-dialog').forEach(function (dialog) {
  dialog.addEventListener('mousedown',function (event) { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
});
paintSelection();
