// psl 1.15.0 ships these types but omits them from its package exports, so
// TypeScript's bundler resolution cannot find them through the module name.
declare module "psl" {
  export const parse: typeof import("../node_modules/psl/types/index").parse;
}
