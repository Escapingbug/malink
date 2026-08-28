import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Android update publisher", () => {
  it("publishes the static channel before the optional local Gateway", () => {
    const root = mkdtempSync(join(tmpdir(), "malink-update-publisher-"));
    temporaryDirectories.push(root);
    const fakeBin = join(root, "bin");
    const bundle = join(root, "bundle");
    const versionCode = 42;
    const relativeArtifact =
      `releases/android/alpha/${versionCode}/malink-native-alpha-42.apk`;
    const artifact = join(bundle, relativeArtifact);
    const releasePath = join(bundle, "client-release.json");
    const staticReleasePath = join(
      bundle,
      "channels",
      "alpha",
      "client-release.json",
    );
    const adminSocket = join(root, "gateway-data", "admin.sock");
    const identityFile = join(root, "deploy-key");
    const sshLog = join(root, "ssh.log");
    const scpLog = join(root, "scp.log");
    const curlLog = join(root, "curl.log");
    const eventLog = join(root, "events.log");
    const bytes = Buffer.from("signed-apk-fixture");
    const artifactUrl =
      `https://pages.example/malink/native-updates/${relativeArtifact}`;

    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(artifact, bytes);
    writeFileSync(identityFile, "test-only-key");
    const release = JSON.stringify({
      platform: "android",
      channel: "alpha",
      architecture: "arm64-v8a",
      versionCode,
      artifact: {
        url: artifactUrl,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    mkdirSync(dirname(staticReleasePath), { recursive: true });
    writeFileSync(releasePath, release);
    writeFileSync(staticReleasePath, release);
    writeExecutable(join(fakeBin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$MALINK_TEST_SSH_LOG"
printf 'ssh %s\\n' "$*" >> "$MALINK_TEST_EVENT_LOG"
cat >/dev/null || true
`);
    writeExecutable(join(fakeBin, "scp"), `#!/bin/sh
printf '%s\\n' "$*" >> "$MALINK_TEST_SCP_LOG"
printf 'scp %s\\n' "$*" >> "$MALINK_TEST_EVENT_LOG"
`);
    writeExecutable(join(fakeBin, "curl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$MALINK_TEST_CURL_LOG"
printf 'curl %s\\n' "$*" >> "$MALINK_TEST_EVENT_LOG"
printf '{"changed":true}'
`);

    const result = spawnSync(resolve("deploy/native-update/publish.sh"), [
      bundle,
      "ubuntu@rd.anciety.my.id",
      adminSocket,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MALINK_TEST_SSH_LOG: sshLog,
        MALINK_TEST_SCP_LOG: scpLog,
        MALINK_TEST_CURL_LOG: curlLog,
        MALINK_TEST_EVENT_LOG: eventLog,
        MALINK_NATIVE_UPDATE_SSH_IDENTITY_FILE: identityFile,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const scpCalls = readFileSync(scpLog, "utf8");
    const sshCalls = readFileSync(sshLog, "utf8");
    expect(scpCalls).toContain(`-i ${identityFile}`);
    expect(scpCalls).toContain("artifact.apk");
    expect(scpCalls).toContain("client-release.json");
    expect(sshCalls).toContain(`-i ${identityFile}`);
    expect(sshCalls).not.toContain(adminSocket);
    const curlCalls = readFileSync(curlLog, "utf8");
    expect(curlCalls).toContain(`--head ${artifactUrl}`);
    expect(curlCalls).toContain(
      "https://pages.example/malink/native-updates/channels/alpha/client-release.json",
    );
    expect(curlCalls).toContain(`--unix-socket ${adminSocket}`);
    expect(curlCalls).toContain(`--data-binary @${releasePath}`);
    expect(curlCalls).toContain("http://localhost/v1/client-releases/android");
    const events = readFileSync(eventLog, "utf8").trim().split("\n");
    const artifactPublicCheck = events.findIndex(
      (event) => event.startsWith("curl ") && event.includes(`--head ${artifactUrl}`),
    );
    const manifestPublish = events.findIndex(
      (event, index) =>
        index > artifactPublicCheck &&
        event.startsWith("ssh ") &&
        event.includes(" sudo sh -s -- "),
    );
    expect(artifactPublicCheck).toBeGreaterThan(-1);
    expect(manifestPublish).toBeGreaterThan(artifactPublicCheck);
    expect(result.stdout).toContain("to the static channel and local Gateway");
  });
});

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
