package id.my.anciety.malink.client.command

import id.my.anciety.malink.security.malink.PairingOperation
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandPayloadValidatorTest {
    @Test
    fun `validates every protocol command operation into a typed payload`() {
        val payloads = listOf(
            buildJsonObject {
                put("operation", "prompt")
                put("sessionId", "session-1")
                put("text", "hello")
            },
            buildJsonObject {
                put("operation", "cancel")
                put("sessionId", "session-1")
                put("targetCommandId", "command-1")
            },
            buildJsonObject {
                put("operation", "decision")
                put("sessionId", "session-1")
                put("requestId", "request-1")
                put("decision", "allow_session")
                put("totp", "123456")
            },
            buildJsonObject {
                put("operation", "artifact.materialize")
                put("sessionId", "session-1")
                put("referenceId", "reference-1")
                put("expectedStatRevision", "revision-1")
            },
            buildJsonObject {
                put("operation", "session.settings")
                put("sessionId", "session-1")
                put("model", "gpt-5")
                put("reasoningEffort", "high")
                put("permissionMode", "accept_edits")
                put("cwd", "/workspace")
                put("projectName", "Project")
            },
            buildJsonObject { put("operation", "session.create") },
            buildJsonObject {
                put("operation", "project.create")
                put("name", "Remote project")
                put("cwd", "/srv/projects/remote")
                put("provider", "codex")
                put("createDirectory", true)
            },
            buildJsonObject {
                put("operation", "project.settings")
                put("name", "Renamed project")
                put("model", "gpt-5")
                put("reasoningEffort", "high")
                put("defaultExtensions", buildJsonArray {
                    add(buildJsonObject { put("id", "review") })
                })
            },
            buildJsonObject { put("operation", "project.delete") },
            buildJsonObject {
                put("operation", "provider.sessions.list")
                put("provider", "codex")
            },
            buildJsonObject {
                put("operation", "provider.session.inspect")
                put("provider", "codex")
                put("providerSessionId", "provider-session-1")
            },
            buildJsonObject {
                put("operation", "provider.history.materialize")
                put("sessionId", "session-1")
                put("expectedFrontier", 0)
                put("limit", 30)
            },
            lifecycle("session.archive"),
            lifecycle("session.restore"),
            lifecycle("session.delete"),
            buildJsonObject {
                put("operation", "device.invite")
                put("lifetimeMs", 30_000)
            },
            buildJsonObject {
                put("operation", "gateway.enrollment.invite")
                put("lifetimeMs", 30_000)
            },
            buildJsonObject {
                put("operation", "gateway.enrollment.approve")
                put("enrollmentId", "enrollment-1")
            },
            buildJsonObject {
                put("operation", "gateway.enrollment.cancel")
                put("enrollmentId", "enrollment-1")
            },
            buildJsonObject {
                put("operation", "gateway.profile.update")
                put("gatewayNodeId", "gateway-node-1")
                put("gatewayName", "Office Mac")
            },
            buildJsonObject {
                put("operation", "gateway.retire")
                put("gatewayNodeId", "gateway-node-old")
                put("expectedDirectoryRevision", 7)
                put("expectedGatewayKeyId", "a".repeat(43))
            },
            buildJsonObject {
                put("operation", "gateway.update.stage")
                put("releaseId", "release-2")
            },
            buildJsonObject {
                put("operation", "gateway.update.apply")
                put("releaseId", "release-2")
                put("mode", "when_idle")
                put("allowForwardOnly", true)
            },
            buildJsonObject {
                put("operation", "gateway.update.status")
            },
            buildJsonObject {
                put("operation", "gateway.restart")
                put("mode", "when_idle")
            },
            buildJsonObject {
                put("operation", "gateway.restart.status")
            },
        )

        assertEquals(CommandOperation.entries, payloads.map { CommandPayloadValidator.validate(it).operation })
        assertTrue(CommandPayloadValidator.validate(payloads[0]) is PromptCommandPayload)
        assertEquals(
            "123456",
            (CommandPayloadValidator.validate(payloads[2]) as DecisionCommandPayload).totp,
        )
        assertTrue(CommandPayloadValidator.validate(payloads[3]) is ArtifactMaterializeCommandPayload)
        assertTrue(CommandPayloadValidator.validate(payloads[5]) is SessionCreateCommandPayload)
        assertTrue(CommandPayloadValidator.validate(payloads[6]) is ProjectCreateCommandPayload)
        assertTrue(
            CommandPayloadValidator.validate(payloads[11])
                is ProviderHistoryMaterializeCommandPayload,
        )
        assertTrue(CommandPayloadValidator.validate(payloads[12]) is SessionLifecycleCommandPayload)
    }

    @Test
    fun `rejects unknown missing extra and incorrectly typed fields`() {
        assertInvalid(buildJsonObject { put("operation", "session.select") })
        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("text", "missing session")
        })
        assertInvalid(buildJsonObject {
            put("operation", "cancel")
            put("sessionId", "session-1")
            put("extra", true)
        })
        assertInvalid(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", 1)
            put("decision", "deny")
        })
        assertInvalid(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", "request-1")
            put("decision", "allow_once")
            put("totp", "12345")
        })
        assertInvalid(buildJsonObject {
            put("operation", "project.create")
            put("name", "Remote project")
            put("cwd", "/srv/projects/remote")
            put("createDirectory", "yes")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.archive")
            put("sessionId", "x".repeat(257))
        })
        assertInvalid(buildJsonObject {
            put("operation", "gateway.update.apply")
            put("releaseId", "release-2")
            put("allowForwardOnly", false)
        })
    }

    @Test
    fun `decision accepts bounded extension action ids`() {
        val parsed = CommandPayloadValidator.validate(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", "interaction-1")
            put("decision", "continue.safe")
        }) as DecisionCommandPayload
        assertEquals("continue.safe", parsed.decision)
        assertInvalid(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", "interaction-1")
            put("decision", "Unsafe action")
        })
    }

    @Test
    fun `prompt requires content and enforces attachment count and aggregate bytes`() {
        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "")
        })

        val attachmentOnly = buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "")
            put("attachments", buildJsonArray { add(attachment("one", 1)) })
        }
        val parsed = CommandPayloadValidator.validate(attachmentOnly) as PromptCommandPayload
        assertEquals(1, parsed.attachments.size)

        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "ok")
            put("attachments", buildJsonArray {
                repeat(11) { add(attachment("item-$it", 1)) }
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "ok")
            put("attachments", buildJsonArray {
                repeat(3) { add(attachment("large-$it", 40L * 1024 * 1024)) }
            })
        })
    }

    @Test
    fun `attachment validation is strict and bounded`() {
        assertInvalid(promptWith(attachment("too-large", CommandPayloadValidator.MAX_ATTACHMENT_BYTES + 1)))
        assertInvalid(promptWith(attachment("bad-hash", 1, sha256 = "not-base64url")))
        assertInvalid(promptWith(attachment("bad-url", 1, url = "https://matrix.example/media")))
        assertInvalid(promptWith(attachment("bad-media-size", 1, mediaSize = 0)))
        assertInvalid(promptWith(attachment("extra", 1, extra = true)))
    }

    @Test
    fun `session settings require at least one valid bounded setting`() {
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("model", "")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("cwd", "x".repeat(4_097))
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("provider", "cursor")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("permissionMode", "always_allow")
        })
        assertTrue(
            CommandPayloadValidator.validate(
                buildJsonObject {
                    put("operation", "session.settings")
                    put("sessionId", "session-1")
                    put("reasoningEffort", "x".repeat(64))
                },
            ) is SessionSettingsCommandPayload,
        )
    }

    @Test
    fun `provider controls accept only bounded string and boolean values`() {
        val parsed = CommandPayloadValidator.validate(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("controls", buildJsonObject {
                put("model", "auto")
                put("planMode", true)
            })
        }) as SessionSettingsCommandPayload
        assertEquals("auto", (parsed.controls?.get("model") as JsonPrimitive).content)
        assertEquals(true, (parsed.controls?.get("planMode") as JsonPrimitive).booleanOrNull)

        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("controls", buildJsonObject {
                put("bad id", "value")
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "project.settings")
            put("controls", buildJsonObject {
                put("nested", buildJsonObject { put("value", "no") })
            })
        })
    }

    @Test
    fun `session create accepts bounded declarative extension bindings`() {
        val payload = buildJsonObject {
            put("operation", "session.create")
            put("scope", "scratch")
            put("extensions", buildJsonArray {
                add(buildJsonObject {
                    put("id", "review-gate")
                    put("config", buildJsonObject {
                        put("policyId", "standard-review")
                        put("requireApproval", true)
                    })
                })
            })
        }
        val parsed = CommandPayloadValidator.validate(payload) as SessionCreateCommandPayload

        assertEquals("scratch", parsed.scope)
        assertEquals(1, parsed.extensions.size)
        assertEquals("review-gate", parsed.extensions.single().id)
        assertEquals("standard-review", parsed.extensions.single().config?.get("policyId")?.let {
            (it as JsonPrimitive).content
        })
        assertFalse(parsed.toString().contains("standard-review"))

        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("extensions", buildJsonArray {
                repeat(9) { index -> add(extension("extension-$index")) }
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("extensions", buildJsonArray {
                add(extension("duplicate"))
                add(extension("duplicate"))
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("extensions", buildJsonArray {
                add(buildJsonObject {
                    put("id", "too-many-settings")
                    put("config", buildJsonObject {
                        repeat(33) { index -> put("setting-$index", true) }
                    })
                })
            })
        })
    }

    @Test
    fun `device invitation accepts only bounded integer lifetime`() {
        for (lifetime in listOf(30_000L, 600_000L)) {
            val parsed = CommandPayloadValidator.validate(
                buildJsonObject {
                    put("operation", "device.invite")
                    put("lifetimeMs", lifetime)
                },
            ) as DeviceInviteCommandPayload
            assertEquals(lifetime, parsed.lifetimeMs)
        }
        assertInvalid(buildJsonObject {
            put("operation", "device.invite")
            put("lifetimeMs", 29_999)
        })
        assertInvalid(buildJsonObject {
            put("operation", "device.invite")
            put("lifetimeMs", JsonPrimitive(30_000.5))
        })
    }

    @Test
    fun `authorization follows explicit grants and upgrades full Workspace members`() {
        assertEquals(
            CommandAuthorizationSource.CERTIFICATE_GRANT,
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.PROMPT,
                listOf(PairingOperation.PROMPT),
            ).source,
        )
        assertEquals(
            CommandAuthorizationSource.CERTIFICATE_GRANT,
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.SESSION_ARCHIVE,
                listOf(PairingOperation.SESSION_ARCHIVE),
            ).source,
        )
        assertEquals(
            CommandAuthorizationSource.CERTIFICATE_GRANT,
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.DEVICE_INVITE,
                listOf(PairingOperation.DEVICE_INVITE),
            ).source,
        )
        for (
            operation in listOf(
                CommandOperation.GATEWAY_ENROLLMENT_INVITE,
                CommandOperation.GATEWAY_ENROLLMENT_APPROVE,
                CommandOperation.GATEWAY_PROFILE_UPDATE,
            )
        ) {
            assertEquals(
                PairingOperation.DEVICE_INVITE,
                requiredCertificateOperation(operation),
            )
            assertEquals(
                CommandAuthorizationSource.CERTIFICATE_GRANT,
                CommandAuthorizationPolicy.evaluate(
                    operation,
                    listOf(PairingOperation.DEVICE_INVITE),
                ).source,
            )
        }
        for (
            operation in listOf(
                CommandOperation.GATEWAY_UPDATE_STAGE,
                CommandOperation.GATEWAY_UPDATE_APPLY,
                CommandOperation.GATEWAY_UPDATE_STATUS,
                CommandOperation.GATEWAY_RESTART,
                CommandOperation.GATEWAY_RESTART_STATUS,
            )
        ) {
            assertEquals(PairingOperation.GATEWAY_UPDATE, requiredCertificateOperation(operation))
            CommandAuthorizationPolicy.requireAuthorized(
                operation,
                listOf(PairingOperation.DEVICE_INVITE),
            )
        }

        val denied = CommandAuthorizationPolicy.evaluate(
            CommandOperation.SESSION_DELETE,
            listOf(PairingOperation.PROMPT),
        )
        assertFalse(denied.authorized)
        assertEquals(CommandAuthorizationSource.DENIED, denied.source)
        assertFalse(
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.PROJECT_CREATE,
                listOf(PairingOperation.PROMPT),
            ).authorized,
        )
        assertFalse(
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.DEVICE_INVITE,
                emptyList(),
            ).authorized,
        )
        CommandOperation.entries.forEach { operation ->
            assertTrue(
                "Full Workspace member should inherit ${operation.wireName}",
                CommandAuthorizationPolicy.evaluate(
                    operation,
                    listOf(PairingOperation.DEVICE_INVITE),
                ).authorized,
            )
        }
    }

    @Test
    fun `validated sensitive payloads redact prompt and encrypted media secrets`() {
        val parsed = CommandPayloadValidator.validate(
            promptWith(
                attachment("attachment-1", 1, name = "secret-name"),
                text = "secret-prompt",
            ),
        )
        val rendered = parsed.toString()
        assertFalse(rendered.contains("secret-prompt"))
        assertFalse(rendered.contains("secret-name"))
        assertFalse(rendered.contains("a".repeat(43)))
    }

    private fun lifecycle(operation: String) = buildJsonObject {
        put("operation", operation)
        put("sessionId", "session-1")
    }

    private fun extension(id: String) = buildJsonObject {
        put("id", id)
        put("config", buildJsonObject { put("enabled", true) })
    }

    private fun promptWith(
        attachment: kotlinx.serialization.json.JsonObject,
        text: String = "ok",
    ) = buildJsonObject {
        put("operation", "prompt")
        put("sessionId", "session-1")
        put("text", text)
        put("attachments", buildJsonArray { add(attachment) })
    }

    private fun attachment(
        id: String,
        size: Long,
        sha256: String = "a".repeat(43),
        url: String = "mxc://matrix.example/media-id",
        mediaSize: Long = size + 16,
        extra: Boolean = false,
        name: String = "name-$id",
    ) = buildJsonObject {
        put("id", id)
        put("name", name)
        put("mimeType", "application/octet-stream")
        put("size", size)
        put("sha256", sha256)
        put("media", buildJsonObject {
            put("url", url)
            put("key", "b".repeat(43))
            put("iv", "c".repeat(16))
            put("sha256", "d".repeat(43))
            put("size", mediaSize)
        })
        if (extra) put("unexpected", true)
    }

    private fun assertInvalid(payload: kotlinx.serialization.json.JsonObject) {
        assertThrows(IllegalArgumentException::class.java) {
            CommandPayloadValidator.validate(payload)
        }
    }
}
