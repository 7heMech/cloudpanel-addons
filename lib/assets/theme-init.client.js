
try {
  document.documentElement.classList.toggle('dark', /(?:^|;\s*)theme=dark(?:;|$)/.test(document.cookie));
} catch (e) {}
