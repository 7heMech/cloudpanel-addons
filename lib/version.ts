export const DEV_VERSION = "0.0.0-dev";

/** The build stamps the release in. */
export const CLI_VERSION: string = process.env.CLP_ADDONS_VERSION || DEV_VERSION;
