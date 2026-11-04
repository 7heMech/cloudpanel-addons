async function saveBranding(body) {
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/branding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    busy(false);
    notify('Saved.', 'ok');
    return reply.data.branding;
  } catch (error) {
    busy(false);
    notify(error.message, 'error');
    // Saved, but the panel's templates were not rendered again.
    return error.data ? error.data.branding : null;
  }
}

async function setBrandingSwitch(input) {
  const wanted = input.checked;
  const branding = await saveBranding({ [input.dataset.branding]: wanted });
  if (!branding) { input.checked = !wanted; return; }
  input.closest('.tweak-row').classList.toggle('is-enabled', wanted);
}

function paintTile(tile, name) {
  tile.querySelector('img').src = name ? CLP_BASE + '/branding/' + name : tile.dataset.fallback;
  tile.querySelector('.branding-reset').hidden = !name;
}

async function uploadLogo(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 512 * 1024) { notify('Images are limited to 512 KB.', 'error'); return; }
  const data = await new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = function () { reject(reader.error); };
    reader.readAsDataURL(file);
  });
  const tile = input.closest('.branding-tile');
  const branding = await saveBranding({ logo: { slot: tile.dataset.slot, data: data } });
  if (branding) paintTile(tile, branding.logos[tile.dataset.slot]);
}

async function resetLogo(button) {
  const tile = button.closest('.branding-tile');
  const branding = await saveBranding({ logo: { slot: tile.dataset.slot, data: '' } });
  if (branding) paintTile(tile, branding.logos[tile.dataset.slot]);
}

async function saveBrandingText(button) {
  const area = document.getElementById(button.dataset.target);
  const branding = await saveBranding({ [area.name]: area.value });
  // After busy(), which puts the button back as it was.
  if (branding) button.disabled = true;
}
