declare const __MALINK_BUILD_VERSION__: string;

export const MALINK_BUILD_VERSION =
  typeof __MALINK_BUILD_VERSION__ === "string"
    ? __MALINK_BUILD_VERSION__
    : "development";
