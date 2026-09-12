package id.my.anciety.malink.client

import org.junit.Assert.*
import org.junit.Test

class DeploymentPresentationPolicyTest {
    @Test fun `hundreds of background observations build only the latest snapshot on resume`() {
        val policy = DeploymentPresentationPolicy()
        var current = 0
        val published = mutableListOf<Int>()
        repeat(310) {
            current++ // Business projection updates independently of presentation.
            policy.update(true) { published += current }
        }
        assertTrue(published.isEmpty())
        policy.flush { published += current }
        policy.flush { published += current }
        assertEquals(listOf(310), published)
    }

    @Test fun `immediate business publication includes pending deployment and clears it`() {
        val policy = DeploymentPresentationPolicy()
        var builds = 0
        policy.update(true) { builds++ }
        policy.update(false) { builds++ }
        policy.flush { builds++ }
        assertEquals(1, builds)
        policy.update(false) { builds++ }
        assertEquals(2, builds)
    }

    @Test fun `failed publication remains retryable and revocation clears pending state`() {
        val policy = DeploymentPresentationPolicy()
        policy.update(true) { fail("must defer") }
        assertThrows(IllegalStateException::class.java) { policy.flush { error("failure") } }
        var builds = 0
        policy.flush { builds++ }
        assertEquals(1, builds)
        policy.update(true) { fail("must defer") }
        policy.clear()
        policy.flush { fail("revoked state must not publish") }
    }

    @Test fun `only ready uncaused background deployment with compatible subscribers defers`() {
        assertTrue(deferDeploymentPresentation("gateway.deployment.status", false, false, true, true))
        assertFalse(deferDeploymentPresentation("gateway.deployment.status", true, false, true, true))
        assertFalse(deferDeploymentPresentation("gateway.deployment.status", false, true, true, true))
        assertFalse(deferDeploymentPresentation("gateway.deployment.status", false, false, false, true))
        assertFalse(deferDeploymentPresentation("gateway.deployment.status", false, false, true, false))
        for (type in listOf("turn.completed", "turn.failed", "assistant.message", "session.lifecycle", "gateway.update.status")) {
            assertFalse(deferDeploymentPresentation(type, false, false, true, true))
        }
    }
}
