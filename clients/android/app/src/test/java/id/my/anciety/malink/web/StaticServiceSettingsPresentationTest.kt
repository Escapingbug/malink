package id.my.anciety.malink.web

import id.my.anciety.malink.config.StaticServiceEndpoint
import org.junit.Assert.assertEquals
import org.junit.Test

class StaticServiceSettingsPresentationTest {
    private val official = StaticServiceEndpoint.parse("https://rd.anciety.my.id")

    @Test
    fun `official PWA remains selectable and visibly current`() {
        assertEquals(
            listOf(
                "Official PWA (current)\nhttps://rd.anciety.my.id/",
                "Custom PWA address…\nUse a mirror or self-hosted HTTPS address",
            ),
            staticServiceSettingsChoices(
                selected = official,
                official = official,
                usesCustom = false,
            ).toList(),
        )
    }

    @Test
    fun `custom PWA exposes its address while retaining the official choice`() {
        val custom = StaticServiceEndpoint.parse("https://mirror.example/malink")

        assertEquals(
            listOf(
                "Official PWA\nhttps://rd.anciety.my.id/",
                "Custom PWA address… (current)\nhttps://mirror.example/malink/",
            ),
            staticServiceSettingsChoices(
                selected = custom,
                official = official,
                usesCustom = true,
            ).toList(),
        )
    }
}
