export type GatewayReleaseBuildIdentity = {
  releaseId: string;
  buildId: string;
};

/**
 * Resolve the optional Gateway release advertised by a static PWA build.
 *
 * A PWA build launched from a running Gateway inherits that service's
 * MALINK_GATEWAY_BUILD_ID. That single value describes the installed Gateway;
 * it is not a request to publish Gateway release metadata in the PWA. Only a
 * release ID opts the static build into that metadata, at which point the
 * matching build ID remains mandatory.
 */
export function gatewayReleaseFromBuildEnvironment(
  environment: NodeJS.ProcessEnv,
): GatewayReleaseBuildIdentity | null {
  const releaseId = environment.MALINK_GATEWAY_RELEASE_ID?.trim();
  const buildId = environment.MALINK_GATEWAY_BUILD_ID?.trim();
  if (!releaseId) return null;
  if (!buildId) {
    throw new Error(
      "MALINK_GATEWAY_BUILD_ID must be set when MALINK_GATEWAY_RELEASE_ID is set.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
    throw new Error("MALINK_GATEWAY_RELEASE_ID is invalid.");
  }
  if (buildId.length > 256) {
    throw new Error("MALINK_GATEWAY_BUILD_ID is too long.");
  }
  return { releaseId, buildId };
}
