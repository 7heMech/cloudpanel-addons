/** What a build that was not cut from a release calls itself. */
export const DEV_VERSION = "0.0.0-dev";

/** The release this binary was built from; the build stamps it in. */
export const CLI_VERSION: string = process.env.CLP_ADDONS_VERSION || DEV_VERSION;
