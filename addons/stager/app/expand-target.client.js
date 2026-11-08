// The copy of expandTarget in service.ts that labels the hostname preview. The
// form sends what was typed and the route expands it, so this copy never
// decides the site; tests/test-action-stager.test.ts holds the two to the same
// answers so the label stays true.
function expandTarget(input, source) {
  const t = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  if (!t) return '';
  return t.indexOf('.') === -1 ? t + '.' + source.replace(/^www\./, '') : t;
}
