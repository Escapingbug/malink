import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNativeClientRelease,
  type AndroidApkMetadata,
} from "./android-update-release.js";

describe("Android static release bundle", () => {
  it("binds immutable APK metadata for static and Gateway publication", () => {
    const apkBytes = Buffer.from("signed-apk-fixture");
    const metadata: AndroidApkMetadata = {
      packageName: "id.my.anciety.malink",
      versionCode: 42,
      versionName: "0.1.0-alpha.42",
      minimumAndroid: 31,
      architecture: "arm64-v8a",
      signingCertificateSha256: "b".repeat(64),
    };
    const release = createNativeClientRelease({
      metadata,
      apkBytes,
      buildId: "android-alpha-42",
      channel: "alpha",
      publishedAt: 1_787_400_000_000,
      baseUrl: "https://rd.anciety.my.id",
      importance: "recommended",
      releaseNotes: ["Reliable direct updates"],
      artifactName: "malink.apk",
    });

    expect(release.artifact.sha256).toBe(
      createHash("sha256").update(apkBytes).digest("hex"),
    );
    expect(release.artifact.url).toContain(
      "/native-updates/releases/android/alpha/42/",
    );
    expect(release).toMatchObject({
      platform: "android",
      versionCode: 42,
      buildId: "android-alpha-42",
    });
    expect(release).not.toHaveProperty("signature");
  });

  it("preserves a path-based static service in the artifact URL", () => {
    const release = createNativeClientRelease({
      metadata: {
        packageName: "id.my.anciety.malink",
        versionCode: 43,
        versionName: "0.1.0-alpha.43",
        minimumAndroid: 31,
        architecture: "arm64-v8a",
        signingCertificateSha256: "b".repeat(64),
      },
      apkBytes: Buffer.from("signed-apk-fixture-43"),
      buildId: "android-alpha-43",
      channel: "alpha",
      publishedAt: 1_787_400_001_000,
      baseUrl: "https://pages.example/malink/",
      importance: "recommended",
      releaseNotes: [],
      artifactName: "malink.apk",
    });

    expect(release.artifact.url).toBe(
      "https://pages.example/malink/native-updates/releases/android/alpha/43/malink.apk",
    );
  });
});
