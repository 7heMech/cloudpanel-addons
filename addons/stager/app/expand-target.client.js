// The copy of expandTarget in service.ts that the hostname preview runs. The
// executable keeps no function source, so the route cannot hand the page its
// own; tests/test-action-stager.test.ts holds the two to the same answers.
function expandTarget(input, source) {
  const t = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  if (!t) return '';
  return t.indexOf('.') === -1 ? t + '.' + source.replace(/^www\./, '') : t;
}
