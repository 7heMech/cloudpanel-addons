try {
  (function (theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark'
      || (theme !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches));
  })((/(?:^|;\s*)theme=(light|dark|auto)(?:;|$)/.exec(document.cookie) || [])[1]);
} catch (e) {}
