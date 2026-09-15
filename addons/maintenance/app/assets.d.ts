// The vendored Ace mode is served to the browser as text, never imported as a
// module here, so it is typed as the string Bun hands back.
declare module "*/ace-mode-html.js" {
  const source: string;
  export default source;
}
