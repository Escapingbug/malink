package id.my.anciety.malink.update

import id.my.anciety.malink.config.StaticServiceEndpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeClientReleaseTest {
    @Test
    fun `static discovery waits one day but recovers from clock rollback`() {
        val interval = NativeUpdateManager.STATIC_CHECK_INTERVAL_MS
        assertEquals(24L * 60L * 60_000L, interval)
        assertTrue(staticReleaseCheckDue(10_000L, 0L, force = false))
        assertFalse(staticReleaseCheckDue(10_000L, 9_000L, force = false))
        assertEquals(interval - 1_000L, staticReleaseCheckDelay(10_000L, 9_000L))
        assertTrue(staticReleaseCheckDue(9_000L + interval, 9_000L, force = false))
        assertTrue(staticReleaseCheckDue(8_000L, 9_000L, force = false))
        assertEquals(0L, staticReleaseCheckDelay(8_000L, 9_000L))
        assertTrue(staticReleaseCheckDue(10_000L, 9_999L, force = true))
    }

    @Test
    fun `an accepted release resumes after process death until the APK is actually ready`() {
        val interrupted = NativeUpdateStatus(
            phase = NativeUpdatePhase.CURRENT,
            currentVersionCode = 41,
            currentVersionName = "41",
        )
        assertFalse(canReusePublishedReleaseStatus(42, 41, interrupted))

        val installed = interrupted.copy(currentVersionCode = 42)
        assertTrue(canReusePublishedReleaseStatus(42, 42, installed))

        val ready = interrupted.copy(
            phase = NativeUpdatePhase.READY,
            latestVersionCode = 42,
        )
        assertTrue(canReusePublishedReleaseStatus(42, 41, ready))
        assertFalse(canReusePublishedReleaseStatus(43, 41, ready))
    }

    @Test
    fun `an already submitted APK install is idempotent`() {
        val ready = NativeUpdateStatus(
            phase = NativeUpdatePhase.READY,
            currentVersionCode = 41,
            currentVersionName = "41",
            latestVersionCode = 42,
        )
        assertFalse(nativeUpdateInstallAlreadySubmitted(ready))
        assertTrue(nativeUpdateInstallAlreadySubmitted(ready.copy(
            phase = NativeUpdatePhase.INSTALLING,
        )))
    }

    private val parser = NativeClientReleaseParser(
        StaticServiceEndpoint.parse("https://updates.example"),
    )

    @Test
    fun `parses a static immutable Android release`() {
        val release = parser.parse(releaseJson())

        assertEquals(42L, release.versionCode)
        assertEquals("alpha", release.channel)
        assertEquals(
            "https://updates.example/native-updates/releases/android/alpha/42/malink.apk",
            release.artifact.url,
        )
        assertEquals(NativeUpdateArtifactSource.STATIC_SERVICE, release.artifact.source)
    }

    @Test
    fun `keeps an exact immutable GitHub Release asset`() {
        val githubUrl =
            "https://github.com/Escapingbug/malink/releases/download/android-alpha-42/malink.apk"
        val release = parser.parse(
            releaseJson().replace(
                "https://updates.example/native-updates/releases/android/alpha/42/malink.apk",
                githubUrl,
            ),
        )

        assertEquals(githubUrl, release.artifact.url)
        assertEquals(NativeUpdateArtifactSource.GITHUB_RELEASE, release.artifact.source)
    }

    @Test
    fun `rejects mutable or foreign GitHub Release assets`() {
        val original =
            "https://updates.example/native-updates/releases/android/alpha/42/malink.apk"
        listOf(
            "https://github.com/Escapingbug/malink/releases/latest/download/malink.apk",
            "https://github.com/Escapingbug/malink/releases/download/android-alpha-43/malink.apk",
            "https://github.com/another/malink/releases/download/android-alpha-42/malink.apk",
            "https://github.com/Escapingbug/malink/releases/download/android-alpha-42/malink.apk?raw=1",
        ).forEach { githubUrl ->
            assertThrows(NativeClientReleaseException::class.java) {
                parser.parse(releaseJson().replace(original, githubUrl))
            }
        }
    }

    @Test
    fun `rebases a portable manifest onto the selected static mirror`() {
        val external = releaseJson().replace("https://updates.example", "https://attacker.example")

        assertEquals(
            "https://updates.example/native-updates/releases/android/alpha/42/malink.apk",
            parser.parse(external).artifact.url,
        )
    }

    @Test
    fun `rejects artifact outside immutable release path`() {
        val unsafe = releaseJson().replace(
            "/native-updates/releases/android/alpha/42/malink.apk",
            "/native-updates/channels/alpha/malink.apk",
        )

        assertThrows(NativeClientReleaseException::class.java) {
            parser.parse(unsafe)
        }
    }

    @Test
    fun `rejects a manifest artifact without a remote HTTPS authority`() {
        listOf(
            releaseJson().replace("https://updates.example", "http://updates.example"),
            releaseJson().replace("https://updates.example", "https:////updates.example"),
        ).forEach { unsafe ->
            assertThrows(NativeClientReleaseException::class.java) {
                parser.parse(unsafe)
            }
        }
    }

    @Test
    fun `policy rejects account-state rollback but accepts same release retry`() {
        val release = parser.parse(releaseJson())
        assertEquals(
            NativeUpdateDecision.Download,
            NativeUpdatePolicy.decide(
                release,
                highestVersionCode = release.versionCode,
                currentVersionCode = 41,
                currentPackageName = "id.my.anciety.malink",
                currentBridgeVersion = 1,
                currentAndroidApi = 36,
                supportedAbis = setOf("arm64-v8a"),
            ),
        )
        assertThrows(NativeClientReleaseException::class.java) {
            NativeUpdatePolicy.decide(
                release,
                highestVersionCode = release.versionCode + 1,
                currentVersionCode = 41,
                currentPackageName = "id.my.anciety.malink",
                currentBridgeVersion = 1,
                currentAndroidApi = 36,
                supportedAbis = setOf("arm64-v8a"),
            )
        }
    }

    private fun releaseJson() = """{
        "platform":"android",
        "channel":"alpha",
        "architecture":"arm64-v8a",
        "packageName":"id.my.anciety.malink",
        "versionCode":42,
        "versionName":"0.1.0-alpha.42",
        "buildId":"android-alpha-42",
        "publishedAt":1787400000000,
        "minimumAndroid":31,
        "nativeBridgeMinimum":1,
        "nativeBridgeMaximum":1,
        "importance":"recommended",
        "releaseNotes":[],
        "artifact":{
            "url":"https://updates.example/native-updates/releases/android/alpha/42/malink.apk",
            "size":1234,
            "sha256":"${"a".repeat(64)}",
            "signingCertificateSha256":"${"b".repeat(64)}"
        }
    }""".trimIndent()
}
