declare const __MALINK_BUILD_VERSION__: string;
declare const __MALINK_GATEWAY_RELEASE__: GatewayReleaseBuild | null;
declare const __MALINK_BASE_PATH__: string;

export type GatewayReleaseBuild = {
  releaseId: string;
  buildId: string;
};

export const MALINK_BUILD_VERSION =
  typeof __MALINK_BUILD_VERSION__ === "string"
    ? __MALINK_BUILD_VERSION__
    : "development";

export const MALINK_GATEWAY_RELEASE =
  typeof __MALINK_GATEWAY_RELEASE__ === "object" &&
    __MALINK_GATEWAY_RELEASE__ !== null
    ? __MALINK_GATEWAY_RELEASE__
    : null;

export const MALINK_BASE_PATH =
  typeof __MALINK_BASE_PATH__ === "string" &&
  __MALINK_BASE_PATH__.startsWith("/") &&
  __MALINK_BASE_PATH__.endsWith("/")
    ? __MALINK_BASE_PATH__
    : "/";
