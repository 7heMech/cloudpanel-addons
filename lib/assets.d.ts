// Stylesheets and browser scripts are imported as text and served as they are,
// never executed or bundled here, so each one is typed as the string Bun hands
// back.
declare module "*.css" {
  const source: string;
  export default source;
}

declare module "*.client.js" {
  const source: string;
  export default source;
}

declare module "*/ace-mode-html.js" {
  const source: string;
  export default source;
}
