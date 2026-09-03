package id.my.anciety.malink.matrix

import java.net.URI
import java.net.URLDecoder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

class MatrixApplicationControlClientTest {
    @Test
    fun `sends only a MLP3 project envelope as a room message with a stable transaction id`() =
        runBlocking {
            lateinit var endpoint: URI
            lateinit var requestReference: ByteArray
            lateinit var requestCopy: ByteArray
            var receivedToken: String? = null
            val responseBody = """{"event_id":"${'$'}control-event"}""".toByteArray()
            val client = MatrixApplicationControlClient(
                MatrixApplicationControlTransport { target, accessToken, body ->
                    endpoint = target
                    receivedToken = accessToken
                    requestReference = body
                    requestCopy = body.copyOf()
                    MatrixHttpResponse(200, responseBody)
                },
            )

            val eventId = client.send(
                storedSession(),
                secureContent(),
                "malink.command.ack/command-1",
            )

            assertEquals("\$control-event", eventId)
            assertEquals("secret-access-token", receivedToken)
            assertEquals(
                "https://matrix.example.org/_matrix/client/v3/rooms/" +
                    "%21room%3Aexample.org/send/m.room.message/" +
                    "malink.command.ack%2Fcommand-1",
                endpoint.toASCIIString(),
            )
            assertEquals(
                3,
                Json.parseToJsonElement(requestCopy.toString(Charsets.UTF_8))
                    .jsonObject.getValue("io.malink").jsonObject
                    .getValue("version").jsonPrimitive.content.toInt(),
            )
            assertTrue(requestReference.all { it == 0.toByte() })
            assertTrue(responseBody.all { it == 0.toByte() })
        }

    @Test
    fun `rejects plaintext control content before transport`() = runBlocking {
        var called = false
        val client = MatrixApplicationControlClient(
            MatrixApplicationControlTransport { _, _, _ ->
                called = true
                MatrixHttpResponse(200, "{}".toByteArray())
            },
        )

        val error = runCatching {
            client.send(
                storedSession(),
                """{"msgtype":"m.text","body":"plaintext"}""",
                "rejected-control",
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertFalse(called)
    }

    @Test
    fun `sends signed permission renewal through the secure control event type`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """{"event_id":"${'$'}renewal-event"}""".toByteArray()
        val client = MatrixApplicationControlClient(
            MatrixApplicationControlTransport { target, _, _ ->
                endpoint = target
                MatrixHttpResponse(200, responseBody)
            },
        )

        val eventId = client.send(
            storedSession(),
            secureControlContent(),
            "malink.capability-renewal.request-1",
        )

        assertEquals("\$renewal-event", eventId)
        assertTrue(
            endpoint.toASCIIString().contains(
                "/send/io.malink.secure_control.v1/",
            ),
        )
    }

    @Test
    fun `recognizes only MLP3 project state and encrypted room messages`() {
        val event = """
            {
              "type":"m.room.message",
              "content":${secureContent()}
            }
        """.trimIndent()

        assertTrue(isMalinkApplicationControlEvent(event))
        assertTrue(isMalinkApplicationControlEvent("""
            {
              "type":"m.room.message",
              "content":${timelineContent()}
            }
        """.trimIndent()))
        assertFalse(isMalinkApplicationControlEvent(secureContent()))
        assertTrue(isMalinkApplicationControlEvent("""
            {
              "type":"m.room.message",
              "content":${secureContent()}
            }
        """.trimIndent()))
        assertFalse(isMalinkApplicationControlEvent("""
            {
              "type":"io.malink.secure_control.v1",
              "content":{"io.malink":{"version":1,"kind":"history_page"}}
            }
        """.trimIndent()))
        assertTrue(isMalinkApplicationControlEvent("""
            {
              "type":"io.malink.secure_control.v1",
              "content":${secureControlContent()}
            }
        """.trimIndent()))
    }

    @Test
    fun `pairing bootstrap timeline accepts only signed response shaped events`() {
        assertTrue(isMalinkPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":{"io.malink":{
                "version":1,
                "kind":"pairing_response",
                "pairing_response":{}
              }}
            }
        """.trimIndent()))
        assertTrue(isMalinkPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":{"io.malink":{
                "version":1,
                "kind":"pairing_rejection",
                "pairing_rejection":{}
              }}
            }
        """.trimIndent()))
        assertFalse(isMalinkPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":${timelineContent()}
            }
        """.trimIndent()))
        assertFalse(isMalinkPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":{"io.malink":{
                "version":1,
                "kind":"pairing_request",
                "pairing_request":{}
              }}
            }
        """.trimIndent()))
    }

    @Test
    fun `SDK timeline routes trusted MLP and only active primary-room pairing`() {
        val binding = storedSession().roomBinding
        val mlp = """{"type":"m.room.message","content":${secureContent()}}"""
        val pairing = """{
          "type":"m.room.message",
          "content":{"io.malink":{
            "version":1,
            "kind":"pairing_response",
            "pairing_response":{}
          }}
        }""".trimIndent()

        assertTrue(shouldDeliverMatrixSdkTimelineEvent(
            binding, binding.roomId, false, binding.gatewayUserId, mlp,
        ))
        assertFalse(shouldDeliverMatrixSdkTimelineEvent(
            binding, binding.roomId, false, "@attacker:example.org", mlp,
        ))
        assertFalse(shouldDeliverMatrixSdkTimelineEvent(
            binding, binding.roomId, false, binding.gatewayUserId, pairing,
        ))
        assertTrue(shouldDeliverMatrixSdkTimelineEvent(
            binding, binding.roomId, true, binding.gatewayUserId, pairing,
        ))
        assertFalse(shouldDeliverMatrixSdkTimelineEvent(
            binding, "!other:example.org", true, binding.gatewayUserId, pairing,
        ))
    }

    @Test
    fun `SDK timeline deduplicator bounds memory and accepts an evicted event again`() {
        val events = MatrixTimelineEventDeduplicator(capacity = 2)

        assertTrue(events.accept("\$first"))
        assertFalse(events.accept("\$first"))
        assertTrue(events.accept("\$second"))
        assertTrue(events.accept("\$third"))
        assertTrue(events.accept("\$first"))
        events.clear()
        assertTrue(events.accept("\$third"))
    }

    @Test
    fun `diagnostics expose only the bounded application event kind`() {
        assertEquals(
            "v3_project_envelope",
            malinkApplicationEventKind("""
                {
                  "type":"m.room.message",
                  "content":${secureContent()}
                }
            """.trimIndent()),
        )
        assertEquals(
            "unknown",
            malinkApplicationEventKind("""
                {"content":{"io.malink":{"kind":"Secret value must not become a diagnostic"}}}
            """.trimIndent()),
        )
        assertEquals("unknown", malinkApplicationEventKind("not-json"))
    }

    @Test
    fun `thread directory pages latest gateway events for complete session discovery`() =
        runBlocking {
            lateinit var endpoint: URI
            val response = """
                {
                  "chunk":[{
                    "event_id":"${'$'}root-1",
                    "sender":"@device:example.org",
                    "unsigned":{"m.relations":{"m.thread":{"latest_event":{
                      "event_id":"${'$'}latest-1",
                      "type":"m.room.message",
                      "sender":"@gateway:example.org",
                      "origin_server_ts":9,
                      "content":${secureContent()}
                    }}}}
                  }],
                  "next_batch":"thread-page-2"
                }
            """.trimIndent().toByteArray()
            val client = MatrixThreadDirectoryClient(
                MatrixApplicationReadTransport { target, _ ->
                    endpoint = target
                    MatrixHttpResponse(200, response)
                },
            )

            val page = client.page(storedSession(), "thread-page-1")

            assertEquals(1, page.candidateThreadCount)
            assertEquals("thread-page-2", page.nextBatch)
            assertEquals(listOf("\$latest-1"), page.latestEvents.map { it.eventId })
            assertTrue(
                endpoint.toASCIIString().contains(
                    "/_matrix/client/v1/rooms/%21room%3Aexample.org/threads?",
                ),
            )
            assertTrue(endpoint.toASCIIString().contains("include=all"))
            assertTrue(endpoint.toASCIIString().contains("from=thread-page-1"))
        }

    @Test
    fun `cold projection reads current MLP3 state without opening another sync`() = runBlocking {
        lateinit var endpoint: URI
        val client = MatrixApplicationRoomStateClient(
            MatrixApplicationReadTransport { target, _ ->
                endpoint = target
                MatrixHttpResponse(
                    200,
                    """[
                      {
                        "type":"io.malink.project.key_grant.v3",
                        "state_key":"project-1.device-1",
                        "event_id":"${'$'}grant",
                        "sender":"@gateway:example.org",
                        "origin_server_ts":10,
                        "content":{
                          "version":3,
                          "kind":"project.key_grant",
                          "sealedGrant":{}
                        }
                      },
                      {
                        "type":"io.malink.project.key_grant.v3",
                        "state_key":"project-1.device-2",
                        "event_id":"${'$'}untrusted",
                        "sender":"@mallory:example.org",
                        "origin_server_ts":11,
                        "content":{
                          "version":3,
                          "kind":"project.key_grant",
                          "sealedGrant":{}
                        }
                      }
                    ]""".trimIndent().toByteArray(),
                )
            },
        )

        val batch = client.currentMlp3(storedSession())

        assertEquals(1, batch.candidateEventCount)
        assertEquals("${'$'}grant", batch.events.single().eventId)
        assertTrue(endpoint.rawPath.endsWith("/rooms/%21room%3Aexample.org/state"))
        assertFalse(endpoint.path.contains("/sync"))
    }

    @Test
    fun `incomplete Workspace recovery reads only the requested project rooms`() = runBlocking {
        val endpoints = mutableListOf<URI>()
        val client = MatrixApplicationRoomStateClient(
            MatrixApplicationReadTransport { target, _ ->
                endpoints += target
                MatrixHttpResponse(200, "[]".toByteArray())
            },
        )

        val batch = client.currentMlp3(
            multiRoomSession(),
            setOf("!room-b:example.org"),
        )

        assertEquals(0, batch.candidateEventCount)
        assertEquals(1, endpoints.size)
        assertTrue(endpoints.single().rawPath.contains("%21room-b%3Aexample.org"))
        assertFalse(endpoints.single().rawPath.contains("%21room%3Aexample.org/state"))
    }

    @Test
    fun `command can target the second Gateway project room`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """{"event_id":"${'$'}second-room"}""".toByteArray()
        val client = MatrixApplicationControlClient(
            MatrixApplicationControlTransport { target, _, _ ->
                endpoint = target
                MatrixHttpResponse(200, responseBody)
            },
        )

        assertEquals(
            "\$second-room",
            client.send(
                multiRoomSession(), secureContent(), "command-second", "!room-b:example.org",
            ),
        )
        assertTrue(endpoint.rawPath.contains("%21room-b%3Aexample.org"))
    }

    @Test
    fun `command reports a missing project route distinctly`() = runBlocking {
        var called = false
        val client = MatrixApplicationControlClient(
            MatrixApplicationControlTransport { _, _, _ ->
                called = true
                MatrixHttpResponse(200, "{}".toByteArray())
            },
        )

        val error = runCatching {
            client.send(
                storedSession(), secureContent(), "command-missing", "!missing:example.org",
            )
        }.exceptionOrNull()

        assertTrue(
            error?.javaClass?.name ?: "No exception was thrown",
            error is UnknownMatrixProjectRoomException,
        )
        assertFalse(called)
    }

    @Test
    fun `command reports a Matrix HTTP rejection distinctly`() = runBlocking {
        val responseBody = """{"errcode":"M_LIMIT_EXCEEDED"}""".toByteArray()
        val client = MatrixApplicationControlClient(
            MatrixApplicationControlTransport { _, _, _ ->
                MatrixHttpResponse(429, responseBody)
            },
        )

        val error = runCatching {
            client.send(storedSession(), secureContent(), "command-rate-limited")
        }.exceptionOrNull()

        assertTrue(error is MatrixApplicationControlRequestException)
        assertEquals(429, (error as MatrixApplicationControlRequestException).statusCode)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `project pointer fetches one exact trusted MLP3 event without scanning history`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "type":"m.room.message",
              "event_id":"${'$'}snapshot-event",
              "sender":"@gateway:example.org",
              "origin_server_ts":1234,
              "content":${secureContent()}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationEventClient(
            MatrixApplicationReadTransport { target, token ->
                endpoint = target
                assertEquals("secret-access-token", token)
                MatrixHttpResponse(200, responseBody)
            },
        )

        val event = client.event(storedSession(), "${'$'}snapshot-event")

        assertEquals("${'$'}snapshot-event", event.eventId)
        assertEquals(
            "/_matrix/client/v3/rooms/%21room%3Aexample.org/event/%24snapshot-event",
            endpoint.rawPath,
        )
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `durable reply recovery reads one bounded recent page in causal order`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "chunk":[
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}terminal",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":20,
                  "content":${secureContent()}
                },
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}progress",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":10,
                  "content":${secureContent()}
                },
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}attacker",
                  "sender":"@attacker:example.org",
                  "origin_server_ts":30,
                  "content":${secureContent()}
                }
              ]
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationTimelineClient(
            MatrixApplicationReadTransport { target, token ->
                endpoint = target
                assertEquals("secret-access-token", token)
                MatrixHttpResponse(200, responseBody)
            },
        )

        val page = client.latest(storedSession(), "!room:example.org", 32)

        assertEquals(listOf("${'$'}progress", "${'$'}terminal"), page.events.map { it.eventId })
        assertEquals(
            "/_matrix/client/v3/rooms/%21room%3Aexample.org/messages",
            endpoint.rawPath,
        )
        assertEquals("dir=b&limit=32", endpoint.rawQuery)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `thread history pages only one session relation and filters untrusted senders`() =
        runBlocking {
            lateinit var endpoint: URI
            val responseBody = """
                {
                  "chunk":[
                    {
                      "type":"m.room.message",
                      "event_id":"${'$'}trusted-history",
                      "sender":"@gateway:example.org",
                      "origin_server_ts":1235,
                      "content":${timelineContent()}
                    },
                    {
                      "type":"m.room.message",
                      "event_id":"${'$'}attacker-history",
                      "sender":"@attacker:example.org",
                      "origin_server_ts":1236,
                      "content":${timelineContent()}
                    }
                  ],
                  "next_batch":"relations-next"
                }
            """.trimIndent().toByteArray()
            val client = MatrixThreadHistoryClient(
                MatrixApplicationReadTransport { target, token ->
                    endpoint = target
                    assertEquals("secret-access-token", token)
                    MatrixHttpResponse(200, responseBody)
                },
            )

            val batch = client.page(
                storedSession(),
                threadRootEventId = "\$thread/root",
                from = "relations/current",
                limit = 37,
            )

            assertEquals(listOf("\$trusted-history"), batch.events.map { it.eventId })
            assertEquals("relations-next", batch.nextBatch)
            assertEquals(
                "/_matrix/client/v1/rooms/%21room%3Aexample.org/relations/" +
                    "%24thread%2Froot/m.thread",
                endpoint.rawPath,
            )
            val query = endpoint.rawQuery.split("&").associate { part ->
                val (key, value) = part.split("=", limit = 2)
                key to URLDecoder.decode(value, Charsets.UTF_8.name())
            }
            assertFalse(query.containsKey("rel_type"))
            assertEquals("b", query["dir"])
            assertEquals("true", query["recurse"])
            assertEquals("32", query["limit"])
            assertEquals("relations/current", query["from"])
            assertTrue(responseBody.all { it == 0.toByte() })
        }

    private fun secureContent() = """
        {
          "msgtype":"m.notice",
          "body":"Encrypted Malink command",
          "io.malink":{
            "version":3,
            "envelope":{
              "version":3,
              "projectId":"project-1",
              "keyId":"key-1",
              "nonce":"AAAAAAAAAAAAAAAA",
              "ciphertext":"AA"
            }
          }
        }
    """.trimIndent()

    private fun timelineContent() = """
        {
          "msgtype":"m.notice",
          "body":"Encrypted Malink timeline event",
          "io.malink":{
            "version":3,
            "envelope":{
              "version":3,
              "projectId":"project-1",
              "keyId":"key-1",
              "nonce":"AAAAAAAAAAAAAAAA",
              "ciphertext":"AQ"
            }
          }
        }
    """.trimIndent()

    private fun secureControlContent() = """
        {
          "msgtype":"m.notice",
          "body":"Encrypted Malink device permission renewal",
          "io.malink":{
            "version":1,
            "kind":"secure_envelope",
            "secure_envelope":{}
          }
        }
    """.trimIndent()

    private fun storedSession() = StoredMatrixSession(
        accessToken = "secret-access-token",
        refreshToken = null,
        userId = "@alice:example.org",
        deviceId = "MATRIX-DEVICE",
        homeserverUrl = "https://matrix.example.org",
        oauthData = null,
        slidingSyncVersion = SlidingSyncVersion.NATIVE,
        roomBinding = MatrixRoomBinding(
            roomId = "!room:example.org",
            gatewayId = "gateway-1",
            conversationId = "conversation-1",
            gatewayUserId = "@gateway:example.org",
            gatewayDeviceId = "GATEWAY-DEVICE",
            gatewayDeviceEd25519 = "A".repeat(43),
        ),
    )

    private fun multiRoomSession() = storedSession().withRoomBindings(listOf(
        storedSession().roomBinding,
        MatrixRoomBinding(
            roomId = "!room-b:example.org",
            gatewayId = "gateway-1",
            conversationId = "conversation-2",
            gatewayUserId = "@gateway-b:example.org",
            gatewayDeviceId = "GATEWAY-DEVICE-B",
            gatewayDeviceEd25519 = "B".repeat(43),
        ),
    ))
}
