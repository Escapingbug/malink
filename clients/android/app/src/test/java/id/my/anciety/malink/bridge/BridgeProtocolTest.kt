package id.my.anciety.malink.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import id.my.anciety.malink.client.NativeClientRuntime
import id.my.anciety.malink.client.events.ClientLifecycle
import id.my.anciety.malink.client.events.ClientSnapshot
import id.my.anciety.malink.client.events.ForegroundServiceState
import id.my.anciety.malink.client.events.LifecyclePhase
import id.my.anciety.malink.client.events.PublicTrustState
import id.my.anciety.malink.client.events.SessionReadUpdate
import id.my.anciety.malink.matrix.MatrixBootstrap
import id.my.anciety.malink.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.malink.matrix.MatrixRoomBinding
import id.my.anciety.malink.matrix.PublicMatrixSession
import id.my.anciety.malink.update.NativeUpdatePhase
import id.my.anciety.malink.update.NativeUpdateStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {
    private val json = Json

    @Test
    fun `strictly parses a shared JSON RPC hello request`() {
        val parsed = BridgeProtocol.parse(helloRequest())

        assertTrue(parsed is BridgeParseResult.Valid)
        val request = (parsed as BridgeParseResult.Valid).request
        assertEquals("hello-1", request.id)
        assertEquals("malink.bridge.hello", request.method)
    }

    @Test
    fun `uses shared JSON RPC failures for parse envelope and method errors`() {
        assertInvalid("not-json", BridgeError.PARSE_ERROR)
        assertInvalid(
            """{"jsonrpc":"1.0","id":"1","method":"malink.bridge.hello","params":{}}""",
            BridgeError.INVALID_REQUEST,
        )
        assertInvalid(
            """{"jsonrpc":"2.0","id":"1","method":"malink.native.eval","params":{}}""",
            BridgeError.METHOD_NOT_FOUND,
        )

        val response = json.parseToJsonElement(
            BridgeProtocol.failure("1", BridgeError.METHOD_NOT_FOUND, "No such method."),
        ).jsonObject
        assertEquals("2.0", response.getValue("jsonrpc").jsonPrimitive.content)
        val error = response.getValue("error").jsonObject
        assertEquals(-32601, error.getValue("code").jsonPrimitive.int)
        assertEquals(
            "METHOD_NOT_FOUND",
            error.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `rejects oversized and deeply nested messages`() {
        val oversized = "x".repeat(BridgeProtocol.MAX_MESSAGE_BYTES + 1)
        assertInvalid(oversized, BridgeError.INVALID_REQUEST)

        var nested = "\"leaf\""
        repeat(BridgeProtocol.MAX_JSON_DEPTH + 2) { nested = "[$nested]" }
        assertInvalid(nested, BridgeError.INVALID_REQUEST)
    }

    @Test
    fun `hello negotiates every implemented requested capability`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val response = successResult(
            dispatch(dispatcher,
                helloRequest(
                    optionalCapabilities = """
                        [
                          {"name":"background.foreground-service","versions":[1]},
                          {"name":"trust.native","versions":[1]},
                          {"name":"commands.durable","versions":[1,2,3,4,5]},
                          {"name":"commands.journal-reconciliation","versions":[1]},
                          {"name":"commands.orphan-retirement","versions":[1]},
                          {"name":"history.page","versions":[1,2,3]},
                          {"name":"client.diagnostics","versions":[1]},
                          {"name":"client.image-save","versions":[1]},
                          {"name":"client.authorization-export","versions":[1]}
                        ]
                    """.trimIndent(),
                ),
            ),
        )
        val capabilities = response.getValue("capabilities").jsonObject

        assertEquals(
            setOf(
                "background.foreground-service",
                "trust.native",
                "commands.durable",
                "commands.journal-reconciliation",
                "commands.orphan-retirement",
                "history.page",
                "client.diagnostics",
                "client.image-save",
                "client.authorization-export",
            ),
            capabilities.keys,
        )
        assertEquals(
            1,
            capabilities.getValue("background.foreground-service").jsonObject
                .getValue("version").jsonPrimitive.int,
        )
        assertEquals(
            5,
            capabilities.getValue("commands.durable").jsonObject
                .getValue("version").jsonPrimitive.int,
        )
        assertEquals(
            3,
            capabilities.getValue("history.page").jsonObject
                .getValue("version").jsonPrimitive.int,
        )
        assertFalse(response.toString().contains("matrix", ignoreCase = true))
        assertTrue(response.toString().contains("durable", ignoreCase = true))
        assertEquals(BRIDGE_SESSION_ID, response.getValue("bridgeSessionId").jsonPrimitive.content)
    }

    @Test
    fun `exports diagnostics through the negotiated native share surface`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"client.diagnostics","versions":[1]}]""",
            ),
        )
        val response = successResult(dispatch(dispatcher, """
            {
              "jsonrpc":"2.0",
              "id":"diagnostics-1",
              "method":"malink.diagnostics.export",
              "params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"}}
            }
        """.trimIndent()))

        assertEquals("share_opened", response.getValue("status").jsonPrimitive.content)
        assertEquals(
            "malink-native-diagnostics.txt",
            response.getValue("filename").jsonPrimitive.content,
        )
        assertEquals(1, runtime.diagnosticExports)
    }

    @Test
    fun `saves one bounded PNG through the negotiated image surface`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"client.image-save","versions":[1]}]""",
            ),
        )
        val request = """
            {
              "jsonrpc":"2.0",
              "id":"image-save-1",
              "method":"malink.image.save",
              "params":{
                "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
                "idempotencyKey":"00000000-0000-4000-8000-000000000099",
                "filename":"malink-invitation-qr-20260903T100000Z.png",
                "mimeType":"image/png",
                "dataBase64":"iVBORw0KGgo="
              }
            }
        """.trimIndent()

        val response = successResult(dispatch(dispatcher, request))
        assertEquals("saved", response.getValue("status").jsonPrimitive.content)
        assertEquals(
            "malink-invitation-qr-20260903T100000Z.png",
            response.getValue("filename").jsonPrimitive.content,
        )
        successResult(dispatch(dispatcher, request))
        assertEquals(1, runtime.savedPngImages.size)
        assertEquals(8, runtime.savedPngImages.single().second)
    }

    @Test
    fun `exports one bounded authorization file through native downloads`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"client.authorization-export","versions":[1]}]""",
            ),
        )
        val request = """
            {
              "jsonrpc":"2.0",
              "id":"authorization-export-1",
              "method":"malink.authorization.export",
              "params":{
                "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
                "idempotencyKey":"00000000-0000-4000-8000-000000000098",
                "filename":"malink-authorization-20260904T100000Z.malink-auth",
                "mimeType":"application/vnd.malink.authorization+json",
                "contents":"{\"kind\":\"malink.authorization-transfer\",\"version\":1}"
              }
            }
        """.trimIndent()

        val response = successResult(dispatch(dispatcher, request))
        assertEquals("saved", response.getValue("status").jsonPrimitive.content)
        assertEquals(
            "malink-authorization-20260904T100000Z.malink-auth",
            response.getValue("filename").jsonPrimitive.content,
        )
        successResult(dispatch(dispatcher, request))
        assertEquals(
            listOf(
                "malink-authorization-20260904T100000Z.malink-auth" to
                    "{\"kind\":\"malink.authorization-transfer\",\"version\":1}",
            ),
            runtime.savedAuthorizationFiles,
        )
    }

    @Test
    fun `orphaned command retirement requires its additive capability`() {
        val dispatcher = BridgeDispatcher(FakeRuntime(), BRIDGE_SESSION_ID)
        dispatch(dispatcher, helloRequest())

        val response = failure(dispatch(dispatcher, """
            {
              "jsonrpc":"2.0",
              "id":"retire-1",
              "method":"malink.command.retire",
              "params":{
                "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
                "idempotencyKey":"00000000-0000-4000-8000-000000000091",
                "commandId":"command-orphaned-1"
              }
            }
        """.trimIndent()))

        assertEquals(
            "CAPABILITY_UNAVAILABLE",
            response.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `hello exposes the selected PWA source only when requested`() {
        val runtime = FakeRuntime().apply {
            pwaSource = NativePwaSource(
                currentBaseUrl = "https://mirror.example/malink/",
                officialBaseUrl = "https://official.example/malink/",
                source = "custom",
            )
        }
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val response = successResult(
            dispatch(
                dispatcher,
                helloRequest(
                    optionalCapabilities =
                        """[{"name":"client.pwa-source","versions":[1]}]""",
                ),
            ),
        )
        val capability = response.getValue("capabilities").jsonObject
            .getValue("client.pwa-source").jsonObject
        val options = capability.getValue("options").jsonObject

        assertEquals(1, capability.getValue("version").jsonPrimitive.int)
        assertEquals(
            "https://mirror.example/malink/",
            options.getValue("currentBaseUrl").jsonPrimitive.content,
        )
        assertEquals("custom", options.getValue("source").jsonPrimitive.content)
    }

    @Test
    fun `hello fails closed when an unavailable capability is required`() {
        val dispatcher = BridgeDispatcher(FakeRuntime(), BRIDGE_SESSION_ID)
        val response = failure(
            dispatch(dispatcher,
                helloRequest(
                    requiredCapabilities =
                        """[{"name":"background.unavailable","versions":[1]}]""",
                ),
            ),
        )

        assertEquals(-32003, response.getValue("code").jsonPrimitive.int)
        assertEquals(
            "CAPABILITY_UNAVAILABLE",
            response.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `manual native update checks are an additive v1 operation and idempotent`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val capabilities = successResult(dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"client.update","versions":[1]}]""",
            ),
        )).getValue("capabilities").jsonObject
        assertEquals(
            1,
            capabilities.getValue("client.update").jsonObject
                .getValue("version").jsonPrimitive.int,
        )

        val request = { id: String ->
            """{"jsonrpc":"2.0","id":"$id","method":"malink.update.check","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$IDEMPOTENCY_KEY"}}"""
        }
        val first = successResult(dispatch(dispatcher, request("check-1")))
        val second = successResult(dispatch(dispatcher, request("check-2")))

        assertEquals("checking", first.getValue("phase").jsonPrimitive.content)
        assertEquals(first, second)
        assertEquals(1, runtime.updateChecks)
    }

    @Test
    fun `snapshot requires hello and the negotiated bridge context`() {
        val dispatcher = BridgeDispatcher(FakeRuntime(), BRIDGE_SESSION_ID)
        val beforeHello = failure(dispatch(dispatcher, snapshotRequest("before", BRIDGE_SESSION_ID)))
        assertEquals("BRIDGE_NOT_READY", beforeHello.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)

        successResult(dispatch(dispatcher, helloRequest()))
        val stale = failure(dispatch(dispatcher, snapshotRequest("stale", "other-session")))
        assertEquals("STALE_WEB_INSTANCE", stale.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)

        val snapshot = successResult(
            dispatch(dispatcher, snapshotRequest("snapshot", BRIDGE_SESSION_ID)),
        )
        assertEquals(1, snapshot.getValue("schemaVersion").jsonPrimitive.int)
        assertEquals("unpaired", snapshot.getValue("lifecycle").jsonObject
            .getValue("phase").jsonPrimitive.content)
        assertEquals("unpaired", snapshot.getValue("trust").jsonObject
            .getValue("state").jsonPrimitive.content)
        assertFalse("sessionReadState" in snapshot)
    }

    @Test
    fun `session receipts are exposed only after additive capability negotiation`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"session.read-receipts","versions":[1]}]""",
            ),
        )
        val snapshot = successResult(
            dispatch(dispatcher, snapshotRequest("snapshot-read", BRIDGE_SESSION_ID)),
        )
        assertEquals(
            40,
            snapshot.getValue("sessionReadState").jsonObject
                .getValue("session-1").jsonPrimitive.int,
        )

        val marked = successResult(dispatch(dispatcher, """
            {
              "jsonrpc":"2.0",
              "id":"mark-read-1",
              "method":"malink.session.markRead",
              "params":{
                "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
                "idempotencyKey":"$IDEMPOTENCY_KEY",
                "sessionId":"session-1",
                "projectId":"project-1"
              }
            }
        """.trimIndent()))
        assertEquals(42, marked.getValue("readUpdatedAt").jsonPrimitive.int)
    }

    @Test
    fun `unexpected native receipt failures retain method and exception diagnostics`() {
        val runtime = FakeRuntime().apply {
            markReadFailure = UnsupportedOperationException("private detail")
        }
        val failures = mutableListOf<Pair<String, String>>()
        val dispatcher = BridgeDispatcher(
            runtime,
            BRIDGE_SESSION_ID,
            unexpectedFailureSink = { method, error ->
                failures += method to error.javaClass.simpleName
            },
        )
        dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"session.read-receipts","versions":[1]}]""",
            ),
        )

        val failed = failure(dispatch(dispatcher, """
            {
              "jsonrpc":"2.0",
              "id":"mark-read-failed",
              "method":"malink.session.markRead",
              "params":{
                "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
                "idempotencyKey":"$IDEMPOTENCY_KEY",
                "sessionId":"session-1",
                "projectId":"project-1"
              }
            }
        """.trimIndent()))

        assertEquals("NATIVE_INTERNAL", failed.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)
        assertEquals(
            listOf("malink.session.markRead" to "UnsupportedOperationException"),
            failures,
        )
    }

    @Test
    fun `start and disconnect use shared context and UUID idempotency shape`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        successResult(dispatch(dispatcher, helloRequest()))

        val missingKey = failure(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"start-bad","method":"malink.client.start","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"}}}""",
        ))
        assertEquals("INVALID_PARAMS", missingKey.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)

        val started = successResult(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"start","method":"malink.client.start","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$IDEMPOTENCY_KEY"}}""",
        ))
        assertTrue(started.getValue("snapshot").jsonObject.getValue("foregroundService").jsonObject
            .getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals(1, runtime.starts)

        val stopped = successResult(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"stop","method":"malink.client.disconnect","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$DISCONNECT_IDEMPOTENCY_KEY","mode":"stop"}}""",
        ))
        assertFalse(stopped.getValue("snapshot").jsonObject.getValue("foregroundService").jsonObject
            .getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals(listOf("stop"), runtime.disconnects)
    }

    @Test
    fun `revoke reaches the native runtime`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        successResult(dispatch(dispatcher, helloRequest()))
        val response = successResult(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"revoke","method":"malink.client.disconnect","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$IDEMPOTENCY_KEY","mode":"revoke"}}""",
        ))
        assertFalse(response.getValue("snapshot").jsonObject.getValue("foregroundService")
            .jsonObject.getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals(listOf("revoke"), runtime.disconnects)
    }

    @Test
    fun `bootstrap is capability gated idempotent and never returns the login token`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val hello = helloRequest(
            optionalCapabilities = """
                [
                  {"name":"background.foreground-service","versions":[1]},
                  {"name":"matrix.session-bootstrap","versions":[3]}
                ]
            """.trimIndent(),
        )
        val capabilities = successResult(dispatch(dispatcher, hello))
            .getValue("capabilities").jsonObject
        assertEquals(
            setOf("background.foreground-service", "matrix.session-bootstrap"),
            capabilities.keys,
        )

        val first = dispatch(dispatcher, bootstrapRequest("bootstrap-1", IDEMPOTENCY_KEY))
        val second = dispatch(dispatcher, bootstrapRequest("bootstrap-2", IDEMPOTENCY_KEY))

        assertEquals(successResult(first), successResult(second))
        assertEquals(1, runtime.bootstraps)
        assertFalse(first.contains("one-time-secret-token"))
        assertFalse(first.contains("accessToken", ignoreCase = true))
        assertEquals(
            "MATRIX-DEVICE",
            successResult(first).getValue("session").jsonObject
                .getValue("matrixDeviceId").jsonPrimitive.content,
        )
        assertEquals(
            1,
            successResult(first).getValue("session").jsonObject
                .getValue("roomBindings").jsonArray.size,
        )

        val conflict = failure(dispatch(
            dispatcher,
            bootstrapRequest("bootstrap-3", IDEMPOTENCY_KEY, deviceName = "Different device"),
        ))
        assertEquals(
            "IDEMPOTENCY_CONFLICT",
            conflict.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `retired account rejoin is not advertised or executable`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val capabilities = successResult(dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"matrix.account-rejoin","versions":[1]}]""",
            ),
        )).getValue("capabilities").jsonObject
        assertFalse(capabilities.containsKey("matrix.account-rejoin"))
        val rejected = failure(dispatch(
            dispatcher,
            rejoinRequest("rejoin-retired", IDEMPOTENCY_KEY),
        ))
        assertEquals(
            "CAPABILITY_UNAVAILABLE",
            rejected.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `session discovery is v3 gated and returns only public routing metadata`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val capabilities = successResult(dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"matrix.session-bootstrap","versions":[3,2,1]}]""",
            ),
        )).getValue("capabilities").jsonObject
        assertEquals(
            3,
            capabilities.getValue("matrix.session-bootstrap").jsonObject
                .getValue("version").jsonPrimitive.int,
        )

        val result = successResult(dispatch(
            dispatcher,
            """{"jsonrpc":"2.0","id":"session","method":"malink.client.session","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"}}}""",
        )).getValue("session").jsonObject
        assertEquals("MATRIX-DEVICE", result.getValue("matrixDeviceId").jsonPrimitive.content)
        assertEquals(2, result.getValue("roomBindings").jsonArray.size)
        assertFalse(result.toString().contains("accessToken", ignoreCase = true))

        val v2Dispatcher = BridgeDispatcher(runtime, "bridge-v2")
        successResult(dispatch(
            v2Dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"matrix.session-bootstrap","versions":[2,1]}]""",
            ).replace(BRIDGE_SESSION_ID, "bridge-v2"),
        ))
        val rejected = failure(dispatch(
            v2Dispatcher,
            """{"jsonrpc":"2.0","id":"session-v2","method":"malink.client.session","params":{"context":{"bridgeSessionId":"bridge-v2"}}}""",
        ))
        assertEquals(
            "CAPABILITY_UNAVAILABLE",
            rejected.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `login token is capability gated bound to an invitation and idempotent in memory`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        successResult(dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"matrix.login-token","versions":[1]}]""",
            ),
        ))

        val first = dispatch(dispatcher, loginTokenRequest("token-1", IDEMPOTENCY_KEY))
        val second = dispatch(dispatcher, loginTokenRequest("token-2", IDEMPOTENCY_KEY))

        assertEquals(successResult(first), successResult(second))
        assertEquals("ready", successResult(first).getValue("status").jsonPrimitive.content)
        assertEquals("single-use-secret", successResult(first).getValue("loginToken").jsonPrimitive.content)
        assertEquals(1, runtime.loginTokenIssues)
        assertEquals(listOf("invite-command-1" to null), runtime.loginTokenInputs)

        val conflict = failure(dispatch(
            dispatcher,
            loginTokenRequest("token-3", IDEMPOTENCY_KEY, password = "different"),
        ))
        assertEquals(
            "IDEMPOTENCY_CONFLICT",
            conflict.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `login-token rate limit exposes only bounded retry metadata`() {
        val response = json.parseToJsonElement(
            BridgeProtocol.failure(
                "token",
                BridgeError.RATE_LIMITED,
                "Try later.",
                retryable = true,
                userAction = "retry",
                retryAfterMs = 12_000,
            ),
        ).jsonObject.getValue("error").jsonObject

        val data = response.getValue("data").jsonObject
        assertEquals("RATE_LIMITED", data.getValue("errorCode").jsonPrimitive.content)
        assertEquals(12_000, data.getValue("retryAfterMs").jsonPrimitive.int)
        assertFalse(response.toString().contains("single-use-secret"))
    }

    @Test
    fun `command blocking details remain structured and bounded`() {
        val response = json.parseToJsonElement(
            BridgeProtocol.failure(
                "command",
                BridgeError.INVALID_STATE,
                "The previous Malink action needs review before another action can start.",
                details = buildJsonObject {
                    put("kind", "command_blocked")
                    put("commandId", "command-1")
                    put("state", "needs_review")
                    put("operation", "session.delete")
                    put("expectedRevision", 9)
                },
            ),
        ).jsonObject.getValue("error").jsonObject

        val details = response.getValue("data").jsonObject.getValue("details").jsonObject
        assertEquals("command_blocked", details.getValue("kind").jsonPrimitive.content)
        assertEquals("command-1", details.getValue("commandId").jsonPrimitive.content)
        assertEquals("needs_review", details.getValue("state").jsonPrimitive.content)
        assertEquals("session.delete", details.getValue("operation").jsonPrimitive.content)
        assertEquals(9, details.getValue("expectedRevision").jsonPrimitive.int)
    }

    private fun helloRequest(
        requiredCapabilities: String = "[]",
        optionalCapabilities: String =
            """[{"name":"background.foreground-service","versions":[1]}]""",
    ): String = """
        {
          "jsonrpc":"2.0",
          "id":"hello-1",
          "method":"malink.bridge.hello",
          "params":{
            "application":"malink-web",
            "webBuild":"test-build",
            "webInstanceId":"550e8400-e29b-41d4-a716-446655440001",
            "supportedProtocolVersions":[1],
            "requiredCapabilities":$requiredCapabilities,
            "optionalCapabilities":$optionalCapabilities
          }
        }
    """.trimIndent()

    private fun snapshotRequest(id: String, sessionId: String): String =
        """{"jsonrpc":"2.0","id":"$id","method":"malink.client.snapshot","params":{"context":{"bridgeSessionId":"$sessionId"}}}"""

    private fun bootstrapRequest(
        id: String,
        idempotencyKey: String,
        deviceName: String = "Malink Android",
    ): String = """
        {
          "jsonrpc":"2.0",
          "id":"$id",
          "method":"malink.client.bootstrap",
          "params":{
            "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
            "idempotencyKey":"$idempotencyKey",
            "homeserver":"https://matrix.example.org",
            "oneTimeLoginToken":"one-time-secret-token",
            "expectedUserId":"@alice:example.org",
            "deviceName":"$deviceName",
            "roomBinding":{
              "roomId":"!room:example.org",
              "gatewayId":"gateway-1",
              "conversationId":"conversation-1",
              "gatewayUserId":"@gateway:example.org",
              "gatewayDeviceId":"GATEWAY-DEVICE",
              "gatewayDeviceEd25519":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
          }
        }
    """.trimIndent()

    private fun loginTokenRequest(
        id: String,
        idempotencyKey: String,
        password: String? = null,
    ): String = """
        {
          "jsonrpc":"2.0",
          "id":"$id",
          "method":"malink.matrix.loginToken",
          "params":{
            "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
            "idempotencyKey":"$idempotencyKey",
            "invitationId":"invite-command-1"
            ${if (password == null) "" else ",\"password\":\"$password\""}
          }
        }
    """.trimIndent()

    private fun rejoinRequest(id: String, idempotencyKey: String): String = """
        {
          "jsonrpc":"2.0",
          "id":"$id",
          "method":"malink.client.rejoin",
          "params":{
            "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
            "idempotencyKey":"$idempotencyKey",
            "pairingLink":"malink://pair?data=signed-offer",
            "homeserver":"https://matrix.example.org",
            "oneTimeLoginToken":"one-time-secret-token",
            "expectedUserId":"@workspace:example.org",
            "deviceName":"Malink Android",
            "roomBinding":{
              "roomId":"!room:example.org",
              "gatewayId":"gateway-1",
              "conversationId":"conversation-1",
              "gatewayUserId":"@gateway:example.org",
              "gatewayDeviceId":"GATEWAY-DEVICE",
              "gatewayDeviceEd25519":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
          }
        }
    """.trimIndent()

    private fun successResult(raw: String) = json.parseToJsonElement(raw).jsonObject
        .getValue("result").jsonObject

    private fun dispatch(dispatcher: BridgeDispatcher, raw: String): String =
        runBlocking { dispatcher.dispatch(raw) }

    private fun failure(raw: String) = json.parseToJsonElement(raw).jsonObject
        .getValue("error").jsonObject

    private fun assertInvalid(raw: String, expectedError: BridgeError) {
        val parsed = BridgeProtocol.parse(raw)
        assertTrue(parsed is BridgeParseResult.Invalid)
        assertEquals(expectedError, (parsed as BridgeParseResult.Invalid).error)
    }

    private class FakeRuntime : BridgeRuntime {
        override val runtimeVersion = "test"
        override val runtimeBuild = "test-build"
        override var pwaSource: NativePwaSource? = null
        override val nativeDeviceId = "native-device-1"
        var starts = 0
        var bootstraps = 0
        var loginTokenIssues = 0
        var updateChecks = 0
        var diagnosticExports = 0
        var markReadFailure: Exception? = null
        val savedPngImages = mutableListOf<Pair<String, Int>>()
        val savedAuthorizationFiles = mutableListOf<Pair<String, String>>()
        val loginTokenInputs = mutableListOf<Pair<String, String?>>()
        val disconnects = mutableListOf<String>()
        private var active = true

        override suspend fun client(): NativeClientRuntime = error("Not used by this protocol fixture.")

        override suspend fun snapshot() = ClientSnapshot(
            deviceId = nativeDeviceId,
            cursor = "cursor-1",
            generatedAt = 100,
            lifecycle = ClientLifecycle(
                phase = if (active) LifecyclePhase.UNPAIRED else LifecyclePhase.STOPPED,
                since = 100,
            ),
            foregroundService = ForegroundServiceState(
                active = active,
                notificationVisible = active,
            ),
            trust = PublicTrustState.Unpaired,
            sessionReadState = mapOf("session-1" to 40L),
        )

        override suspend fun start(): ClientSnapshot {
            starts += 1
            active = true
            return snapshot()
        }

        override suspend fun exportDiagnostics(): String {
            diagnosticExports += 1
            return "malink-native-diagnostics.txt"
        }

        override suspend fun savePngImage(filename: String, bytes: ByteArray): String {
            savedPngImages += filename to bytes.size
            return filename
        }

        override suspend fun saveAuthorizationFile(filename: String, bytes: ByteArray): String {
            savedAuthorizationFiles += filename to bytes.toString(Charsets.UTF_8)
            return filename
        }

        override suspend fun bootstrap(
            input: MatrixBootstrap,
        ): Pair<PublicMatrixSession, ClientSnapshot> {
            bootstraps += 1
            return PublicMatrixSession(
                homeserver = input.homeserver,
                userId = input.expectedUserId,
                matrixDeviceId = "MATRIX-DEVICE",
                roomBinding = input.roomBinding,
            ) to snapshot()
        }

        override suspend fun publicMatrixSession(): PublicMatrixSession = PublicMatrixSession(
            homeserver = "https://matrix.example.org",
            userId = "@alice:example.org",
            matrixDeviceId = "MATRIX-DEVICE",
            roomBindings = listOf(
                MatrixRoomBinding(
                    roomId = "!room:example.org",
                    gatewayId = "gateway-1",
                    conversationId = "conversation-1",
                    gatewayUserId = "@gateway:example.org",
                    gatewayDeviceId = "GATEWAY-DEVICE",
                    gatewayDeviceEd25519 = "A".repeat(43),
                ),
                MatrixRoomBinding(
                    roomId = "!room-two:example.org",
                    gatewayId = "gateway-1",
                    conversationId = "conversation-2",
                    gatewayUserId = "@gateway:example.org",
                    gatewayDeviceId = "GATEWAY-DEVICE",
                    gatewayDeviceEd25519 = "A".repeat(43),
                ),
            ),
        )

        override suspend fun issueMatrixLoginToken(
            invitationId: String,
            password: String?,
        ): MatrixLoginTokenIssueResult {
            loginTokenIssues += 1
            loginTokenInputs += invitationId to password
            return MatrixLoginTokenIssueResult.Ready("single-use-secret", 120_000)
        }

        override suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> = error("Not used by this fixture.")

        override suspend fun disconnect(mode: String): ClientSnapshot {
            disconnects += mode
            active = false
            return snapshot()
        }

        override suspend fun markSessionRead(
            sessionId: String,
            projectId: String?,
        ): SessionReadUpdate {
            markReadFailure?.let { throw it }
            return SessionReadUpdate(sessionId, projectId, 42)
        }

        override fun checkNativeUpdate(): NativeUpdateStatus {
            updateChecks += 1
            return NativeUpdateStatus(
                phase = NativeUpdatePhase.CHECKING,
                currentVersionCode = 1,
                currentVersionName = "test",
            )
        }
    }

    private companion object {
        const val BRIDGE_SESSION_ID = "bridge-session-1"
        const val IDEMPOTENCY_KEY = "550e8400-e29b-41d4-a716-446655440000"
        const val DISCONNECT_IDEMPOTENCY_KEY = "550e8400-e29b-41d4-a716-446655440002"
    }
}
