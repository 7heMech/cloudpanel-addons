// A setting's wording, opened and closed on a phone.
function toggleNote(button) {
  const row = button.closest('.tweak-row');
  const open = row.classList.toggle('is-open');
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}
