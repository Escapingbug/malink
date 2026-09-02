package id.my.anciety.malink.web

import id.my.anciety.malink.config.StaticServiceEndpoint
import org.junit.Assert.assertEquals
import org.junit.Test

class StaticServiceSettingsPresentationTest {
    private val official = StaticServiceEndpoint.parse("https://escapingbug.github.io/malink/")

    @Test
    fun `official PWA remains selectable and visibly current`() {
        assertEquals(
            StaticServiceSettingsPresentation(
                currentSource = "Official PWA",
                currentBaseUrl = "https://escapingbug.github.io/malink/",
                officialAction = "Switch to official PWA",
                officialBaseUrl = "https://escapingbug.github.io/malink/",
                customAction = "Set a custom PWA address",
                customDetail = "Use a trusted mirror or self-hosted HTTPS address",
            ),
            staticServiceSettingsPresentation(
                selected = official,
                official = official,
                usesCustom = false,
            ),
        )
    }

    @Test
    fun `custom PWA exposes its address while retaining the official choice`() {
        val custom = StaticServiceEndpoint.parse("https://mirror.example/malink")

        assertEquals(
            StaticServiceSettingsPresentation(
                currentSource = "Custom PWA",
                currentBaseUrl = "https://mirror.example/malink/",
                officialAction = "Switch to official PWA",
                officialBaseUrl = "https://escapingbug.github.io/malink/",
                customAction = "Edit custom PWA address",
                customDetail = "https://mirror.example/malink/",
            ),
            staticServiceSettingsPresentation(
                selected = custom,
                official = official,
                usesCustom = true,
            ),
        )
    }
}
