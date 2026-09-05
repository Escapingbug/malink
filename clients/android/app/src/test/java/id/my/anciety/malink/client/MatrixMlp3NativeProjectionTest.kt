package id.my.anciety.malink.client

import id.my.anciety.malink.client.events.ClientMessageKind
import id.my.anciety.malink.client.events.ToolCategory
import id.my.anciety.malink.client.events.ToolPhase
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixMlp3NativeProjectionTest {
    @Test
    fun `provider catalog pages replace embedded models and survive durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "inline-old"), "\$workspace", null)
        projection.applyGatewayEvent(providerCatalogManifest(2, 2), "\$manifest", null)
        projection.applyGatewayEvent(providerCatalogPage(1, "model-b"), "\$page-b", null)
        projection.applyGatewayEvent(providerCatalogPage(0, "model-a"), "\$page-a", null)

        val capabilities = projection.snapshot()!!.getValue("capabilities").jsonObject
        assertEquals(
            listOf("model-a", "model-b"),
            capabilities.getValue("models").jsonArray.map {
                it.jsonObject.getValue("id").jsonPrimitive.content
            },
        )
        val controls = capabilities.getValue("controls").jsonArray
        assertEquals(
            2,
            controls.first().jsonObject.getValue("options").jsonArray.size,
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(
            listOf("model-a", "model-b"),
            restored.snapshot()!!.getValue("capabilities").jsonObject
                .getValue("models").jsonArray.map {
                    it.jsonObject.getValue("id").jsonPrimitive.content
                },
        )
    }

    @Test
    fun `provider catalogs remain isolated per project and report incomplete recovery targets`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project-1", null)
        projection.applyGatewayEvent(
            projectSnapshot("project-2", "Project Two", "/workspace/two"),
            "\$project-2",
            null,
        )
        projection.applyGatewayEvent(workspaceSnapshot(1, "inline-one"), "\$workspace-1", null)
        projection.applyGatewayEvent(
            workspaceSnapshot(1, "inline-two", projectId = "project-2"),
            "\$workspace-2",
            null,
        )
        projection.applyGatewayEvent(
            providerCatalogManifest(1, 1, "project-1", "a".repeat(43)),
            "\$manifest-1",
            null,
        )
        assertEquals(setOf("project-1"), projection.incompleteProviderCatalogProjectIds())
        projection.applyGatewayEvent(
            providerCatalogPage(0, "model-one", "project-1", "a".repeat(43), 1),
            "\$page-1",
            null,
        )
        projection.applyGatewayEvent(
            providerCatalogManifest(1, 1, "project-2", "b".repeat(43)),
            "\$manifest-2",
            null,
        )
        projection.applyGatewayEvent(
            providerCatalogPage(0, "model-two", "project-2", "b".repeat(43), 1),
            "\$page-2",
            null,
        )

        assertTrue(projection.incompleteProviderCatalogProjectIds().isEmpty())
        val projectModels = projection.snapshot()!!.getValue("projects").jsonArray.associate {
            val project = it.jsonObject
            project.getValue("project_id").jsonPrimitive.content to
                project.getValue("capabilities").jsonObject.getValue("models")
                    .jsonArray.single().jsonObject.getValue("id").jsonPrimitive.content
        }
        assertEquals(
            mapOf("project-1" to "model-one", "project-2" to "model-two"),
            projectModels,
        )
    }

    @Test
    fun `missing manifests keep paginated catalog projects in recovery`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            workspaceSnapshot(1, "unused", embeddedModels = false),
            "\$workspace",
            null,
        )

        assertEquals(setOf("project-1"), projection.incompleteProviderCatalogProjectIds())
        val missingControls = projection.snapshot()!!.getValue("capabilities").jsonObject
            .getValue("controls").jsonArray
        assertEquals("model", missingControls.single().jsonObject
            .getValue("id").jsonPrimitive.content)
        assertEquals("loading", missingControls.single().jsonObject
            .getValue("status").jsonPrimitive.content)
        projection.applyGatewayEvent(providerCatalogManifest(1, 1), "\$manifest", null)
        assertEquals(setOf("project-1"), projection.incompleteProviderCatalogProjectIds())
        projection.applyGatewayEvent(
            providerCatalogPage(0, "model-new", pageCount = 1),
            "\$page",
            null,
        )
        assertTrue(projection.incompleteProviderCatalogProjectIds().isEmpty())
    }

    @Test
    fun `legacy unscoped catalogs are discarded and can be recovered with the same event identity`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "inline-old"), "\$workspace", null)
        projection.applyGatewayEvent(providerCatalogManifest(1, 1), "\$manifest", null)
        projection.applyGatewayEvent(
            providerCatalogPage(0, "model-new", pageCount = 1),
            "\$page",
            null,
        )
        val current = projection.durableState()
        val legacy = JsonObject(current
            .filterKeys { it !in setOf("providerCatalogPages", "providerCatalogManifests") } +
            mapOf(
                "schemaVersion" to JsonPrimitive(21),
                "providerCatalogPages" to JsonArray(
                    current.getValue("providerCatalogPages").jsonArray.map { element ->
                        JsonObject(element.jsonObject.filterKeys { it != "projectId" })
                    },
                ),
                "providerCatalogManifests" to JsonArray(
                    current.getValue("providerCatalogManifests").jsonArray.map { element ->
                        JsonObject(element.jsonObject.filterKeys { it != "projectId" })
                    },
                ),
            ))
        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = legacy,
        )
        assertEquals(
            "inline-old",
            restored.snapshot()!!.getValue("capabilities").jsonObject
                .getValue("models").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )

        restored.applyGatewayEvent(providerCatalogManifest(1, 1), "\$manifest-retry", null)
        restored.applyGatewayEvent(
            providerCatalogPage(0, "model-new", pageCount = 1),
            "\$page-retry",
            null,
        )
        assertEquals(
            "model-new",
            restored.snapshot()!!.getValue("capabilities").jsonObject
                .getValue("models").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
    }

    @Test
    fun `current caches recover catalogs even when old dedupe IDs remain`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "inline-old"), "\$workspace", null)
        projection.applyGatewayEvent(providerCatalogManifest(1, 1), "\$manifest", null)
        projection.applyGatewayEvent(
            providerCatalogPage(0, "model-new", pageCount = 1),
            "\$page",
            null,
        )
        val current = projection.durableState()
        val poisoned = JsonObject(current + mapOf(
            "providerCatalogPages" to JsonArray(emptyList()),
            "providerCatalogManifests" to JsonArray(emptyList()),
        ))
        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = poisoned,
        )

        restored.applyGatewayEvent(providerCatalogManifest(1, 1), "\$manifest-retry", null)
        restored.applyGatewayEvent(
            providerCatalogPage(0, "model-new", pageCount = 1),
            "\$page-retry",
            null,
        )
        assertEquals(
            "model-new",
            restored.snapshot()!!.getValue("capabilities").jsonObject
                .getValue("models").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
    }

    @Test
    fun `split schema twenty projection variants preserve sessions during upgrade`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(providerCatalogManifest(2, 2), "\$manifest", null)
        projection.applyGatewayEvent(providerCatalogPage(0, "model-a"), "\$page-a", null)
        projection.applyGatewayEvent(providerCatalogPage(1, "model-b"), "\$page-b", null)
        projection.applyGatewayEvent(turn("started", 2, "working"), "\$started", "\$root-a")
        projection.applyGatewayEvent(turn("completed", 3, "idle"), "\$completed", "\$root-a")
        val current = projection.durableState()
        assertEquals(22, current.getValue("schemaVersion").jsonPrimitive.content.toInt())

        val providerCatalogOnly = JsonObject(current.filterKeys {
            it != "completionObservations"
        } + ("schemaVersion" to JsonPrimitive(20)))
        val completionOnly = JsonObject(current.filterKeys {
            it != "providerCatalogPages" && it != "providerCatalogManifests"
        } + ("schemaVersion" to JsonPrimitive(20)))

        listOf(providerCatalogOnly, completionOnly).forEach { legacy ->
            val restored = MatrixMlp3NativeProjection(
                gatewayId = { "gateway-1" },
                activeDeviceCount = { 2 },
                initialState = legacy,
            )
            val session = restored.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
            assertEquals("session-a", session.getValue("id").jsonPrimitive.content)
            assertEquals("idle", session.getValue("activity_phase").jsonPrimitive.content)
        }
    }

    @Test
    fun `semantic validation rejects a structurally valid but incompatible cache`() {
        val incompatible = buildJsonObject {
            put("schemaVersion", 14)
        }

        assertThrows(IllegalArgumentException::class.java) {
            validateMatrixMlp3ProjectionState(incompatible)
        }
    }

    @Test
    fun `authoritative Workspace Directory distinguishes active and removed projects`() {
        val projection = projection()
        assertNull(projection.workspaceHasProject("project-1"))
        projection.applyWorkspaceGatewayDirectory(buildJsonObject {
            put("directory", buildJsonObject {
                put("revision", 1)
                put("gateways", buildJsonArray {
                    add(buildJsonObject {
                        put("projects", buildJsonArray {
                            add(buildJsonObject { put("projectId", "project-1") })
                        })
                    })
                })
            })
        })

        assertEquals(true, projection.workspaceHasProject("project-1"))
        assertEquals(false, projection.workspaceHasProject("project-removed"))
    }

    @Test
    fun `historical Workspace Directory replay cannot replace the current route`() {
        val projection = projection()
        fun directory(revision: Int, projectId: String) = buildJsonObject {
            put("directory", buildJsonObject {
                put("revision", revision)
                put("gateways", buildJsonArray {
                    add(buildJsonObject {
                        put("projects", buildJsonArray {
                            add(buildJsonObject { put("projectId", projectId) })
                        })
                    })
                })
            })
        }
        assertTrue(projection.applyWorkspaceGatewayDirectory(directory(2, "project-current")))

        assertFalse(projection.applyWorkspaceGatewayDirectory(directory(1, "project-stale")))
        assertEquals(2, projection.workspaceGatewayDirectoryRevision())
        assertEquals(true, projection.workspaceHasProject("project-current"))
        assertEquals(false, projection.workspaceHasProject("project-stale"))
    }

    @Test
    fun `session receipt target binds the current projection to one physical Matrix event`() {
        val projection = projection()
        projection.applyWorkspaceGatewayDirectory(buildJsonObject {
            put("directory", buildJsonObject {
                put("revision", 1)
                put("gateways", buildJsonArray {
                    add(buildJsonObject {
                        put("projects", buildJsonArray {
                            add(buildJsonObject {
                                put("projectId", "project-1")
                                put("roomId", "!project:example.org")
                            })
                        })
                    })
                })
            })
        })
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$ready-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(turn("started", 2, "working"), "\$started-a", "\$root-a")

        val expected = MatrixMlp3SessionReadReceiptTarget(
            sessionId = "session-a",
            projectId = "project-1",
            roomId = "!project:example.org",
            threadRootEventId = "\$root-a",
            eventId = "\$started-a",
            updatedAt = 200,
        )
        assertEquals(expected, projection.sessionReadReceiptTarget("session-a", "project-1"))

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(expected, restored.sessionReadReceiptTarget("session-a", "project-1"))
    }

    @Test
    fun `session receipt target requires a matching Matrix thread relation`() {
        val projection = projection()
        projection.applyWorkspaceGatewayDirectory(buildJsonObject {
            put("directory", buildJsonObject {
                put("revision", 1)
                put("gateways", buildJsonArray {
                    add(buildJsonObject {
                        put("projects", buildJsonArray {
                            add(buildJsonObject {
                                put("projectId", "project-1")
                                put("roomId", "!project:example.org")
                            })
                        })
                    })
                })
            })
        })
        projection.applyOwnCommand(
            sessionCreateCommand("session-a", title = "Session A"),
            "\$root-a",
            50,
        )

        assertNull(projection.sessionReadReceiptTarget("session-a", "project-1"))
        assertEquals(
            id.my.anciety.malink.client.events.SessionReadUpdate(
                sessionId = "session-a",
                projectId = "project-1",
                readUpdatedAt = 50,
            ),
            projection.sessionReadUpdate("session-a", "project-1"),
        )

        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$unthreaded",
            null,
        )
        assertNull(projection.sessionReadReceiptTarget("session-a", "project-1"))

        projection.applyGatewayEvent(
            turn("started", 2, "working"),
            "\$wrong-thread",
            "\$root-b",
        )
        assertNull(projection.sessionReadReceiptTarget("session-a", "project-1"))

        projection.applyGatewayEvent(
            turn("completed", 3, "idle"),
            "\$threaded",
            "\$root-a",
        )
        assertEquals(
            "\$threaded",
            projection.sessionReadReceiptTarget("session-a", "project-1")?.eventId,
        )

        projection.applyGatewayEvent(
            turn("completed", 4, "idle"),
            "\$later-unthreaded",
            null,
        )
        assertNull(projection.sessionReadReceiptTarget("session-a", "project-1"))
    }

    @Test
    fun `legacy receipt target without thread proof is discarded during restore`() {
        val projection = projection()
        projection.applyWorkspaceGatewayDirectory(buildJsonObject {
            put("directory", buildJsonObject {
                put("revision", 1)
                put("gateways", buildJsonArray {
                    add(buildJsonObject {
                        put("projects", buildJsonArray {
                            add(buildJsonObject {
                                put("projectId", "project-1")
                                put("roomId", "!project:example.org")
                            })
                        })
                    })
                })
            })
        })
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$ready-a",
            "\$root-a",
        )
        val current = projection.durableState()
        val legacySessions = JsonArray(current.getValue("sessions").jsonArray.map { element ->
            JsonObject(element.jsonObject.filterKeys { it != "readReceiptThreadRootEventId" })
        })
        val legacy = JsonObject(
            current +
                ("schemaVersion" to JsonPrimitive(21)) +
                ("sessions" to legacySessions),
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = legacy,
        )

        assertNull(restored.sessionReadReceiptTarget("session-a", "project-1"))
    }

    @Test
    fun `two Gateway projects remain distinct across durable restore and route removal`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project-a", null)
        projection.applyGatewayEvent(
            projectSnapshot("project-2", "Project Two", "/workspace/two"),
            "\$project-b",
            null,
        )
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(
            sessionReady(
                "session-b", 1, "Session B", 200,
                cwd = "/workspace/two", projectId = "project-2",
            ),
            "\$root-b",
            "\$root-b",
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        val snapshot = restored.snapshot()!!
        assertEquals(
            listOf("project-1", "project-2"),
            snapshot.getValue("projects").jsonArray.map {
                it.jsonObject.getValue("project_id").jsonPrimitive.content
            },
        )
        val sessions = snapshot.getValue("sessions").jsonArray.associateBy {
            it.jsonObject.getValue("id").jsonPrimitive.content
        }
        assertEquals(
            "Project Two",
            sessions.getValue("session-b").jsonObject
                .getValue("project_name").jsonPrimitive.content,
        )
        assertEquals("project-2", restored.projectId("session-b"))

        restored.retainProjects(setOf("project-2"))
        assertNull(restored.projectId("session-a"))
        assertEquals(
            listOf("project-2"),
            restored.snapshot()!!.getValue("projects").jsonArray.map {
                it.jsonObject.getValue("project_id").jsonPrimitive.content
            },
        )
    }

    @Test
    fun `out of order state converges and a tombstone removes only its session`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", stateVersion = 5, title = "Newest A", updatedAt = 500),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(
            sessionReady("session-a", stateVersion = 3, title = "Stale A", updatedAt = 300),
            "\$stale-a",
            "\$stale-a",
        )
        projection.applyGatewayEvent(
            sessionReady("session-b", stateVersion = 1, title = "Session B", updatedAt = 400),
            "\$root-b",
            "\$root-b",
        )

        var sessions = projection.snapshot()!!.getValue("sessions").jsonArray
        assertEquals(listOf("Newest A", "Session B"), sessions.map { sessionTitle(it.jsonObject) })
        assertEquals("\$root-a", projection.threadRootEventId("session-a"))
        assertEquals("active", projection.sessionLifecycle("session-a"))

        projection.applyGatewayEvent(
            sessionLifecycle("session-a", stateVersion = 6, lifecycle = "deleted"),
            "\$deleted-a",
            "\$root-a",
        )
        sessions = projection.snapshot()!!.getValue("sessions").jsonArray
        assertEquals(listOf("Session B"), sessions.map { sessionTitle(it.jsonObject) })
        assertNull(projection.threadRootEventId("session-a"))
        assertNull(projection.sessionLifecycle("session-a"))
        assertEquals("\$root-b", projection.threadRootEventId("session-b"))
    }

    @Test
    fun `replayed own session create cannot overwrite a newer Gateway terminal`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$ready-a",
            null,
        )
        projection.applyGatewayEvent(turn("started", 2, "working"), "\$started-a", null)
        projection.applyGatewayEvent(turn("completed", 3, "idle"), "\$completed-a", null)

        projection.applyOwnCommand(
            sessionCreateCommand("session-a", title = "Stale title"),
            "\$root-a",
            50,
        )

        val session = projection.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject
        assertEquals("Session A", session.getValue("title").jsonPrimitive.content)
        assertEquals("idle", session.getValue("status").jsonPrimitive.content)
        assertEquals(3L, session.getValue("state_version").jsonPrimitive.content.toLong())
        assertFalse("active_turn_id" in session)
        assertEquals("\$root-a", projection.threadRootEventId("session-a"))
    }

    @Test
    fun `terminal reconciliation remains authoritative over a delayed running event`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(
            commandReconciledTerminal("session-a", "turn-1"),
            "\$reconciled-a",
            "\$root-a",
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        restored.applyGatewayEvent(turn("started", 2, "working"), "\$started-a", "\$root-a")

        val session = restored.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject
        assertEquals("idle", session.getValue("status").jsonPrimitive.content)
        assertFalse("active_turn_id" in session)
    }

    @Test
    fun `authoritative project snapshot can rebuild an evicted projection`() {
        val projection = projection()
        val snapshot = projectSnapshot()
        projection.applyGatewayEvent(snapshot, "\$project", null)
        projection.retainProjects(emptySet())
        assertTrue(projection.projectedProjectIds().isEmpty())

        val replay = projection.applyGatewayEvent(snapshot, "\$project", null)

        assertTrue(replay.changed)
        assertEquals(setOf("project-1"), projection.projectedProjectIds())
    }

    @Test
    fun `provider history room pages retain speaker order and durable frontier`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        val binding = buildJsonObject {
            put("roomId", "!history:example.org")
            put("snapshotId", "snapshot-1")
            put("ordering", "reverse_append_v1")
        }
        projection.applyGatewayEvent(
            sessionReady(
                "session-a",
                stateVersion = 1,
                title = "Recovered",
                updatedAt = 100,
                providerHistory = binding,
            ),
            "\$root-a",
            "\$root-a",
        )

        val committed = projection.applyGatewayEvent(
            event(
                eventId = "history-page-0",
                projectId = "project-1",
                sessionId = "session-a",
                payload = buildJsonObject {
                    put("type", "provider.history.page.committed")
                    put("snapshotId", "snapshot-1")
                    put("pageIndex", 0)
                    put("previousFrontier", 0)
                    put("frontier", 1)
                    put("messageCount", 1)
                    put("hasMore", false)
                    put("digest", "A".repeat(43))
                },
            ),
            "\$history-page-0",
            null,
        )
        assertTrue(committed.messages.isEmpty())
        assertEquals(setOf("!history:example.org"), projection.providerHistoryRoomIds())
        assertFalse(projection.providerHistoryHasMore("session-a"))

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        val secondPart = restored.applyGatewayEvent(
            event(
                eventId = "history-message-2-part-1",
                projectId = "project-1",
                sessionId = "session-a",
                payload = buildJsonObject {
                    put("type", "provider.history.message")
                    put("snapshotId", "snapshot-1")
                    put("sourceMessageId", "provider-message-2")
                    put("sourceOrdinal", 2)
                    put("role", "assistant")
                    put("body", "answer")
                    put("pageIndex", 0)
                    put("partIndex", 1)
                    put("partCount", 2)
                },
            ),
            "\$history-message-2-part-1",
            null,
        )
        assertTrue(secondPart.messages.isEmpty())

        val historical = restored.applyGatewayEvent(
            event(
                eventId = "history-message-2-part-0",
                projectId = "project-1",
                sessionId = "session-a",
                payload = buildJsonObject {
                    put("type", "provider.history.message")
                    put("snapshotId", "snapshot-1")
                    put("sourceMessageId", "provider-message-2")
                    put("sourceOrdinal", 2)
                    put("role", "assistant")
                    put("body", "Earlier ")
                    put("pageIndex", 0)
                    put("partIndex", 0)
                    put("partCount", 2)
                },
            ),
            "\$history-message-2-part-0",
            null,
        ).messages.single()
        assertEquals("Earlier answer", historical.text)
        assertEquals(true, historical.historical)
        assertEquals(ClientMessageKind.AGENT, historical.kind)
        assertEquals("5", historical.semantic?.get("providerHistoryOrder")?.jsonPrimitive?.content)
        assertEquals(binding, restored.providerHistory("session-a"))
        assertFalse(restored.providerHistoryHasMore("session-a"))
    }

    @Test
    fun `logical message ids are stable across duplicate physical Matrix events`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val first = projection.applyGatewayEvent(
            assistant("logical-event-1", "message-1", "first body"),
            "\$physical-1",
            "\$root-a",
        )
        val replay = projection.applyGatewayEvent(
            assistant("logical-event-2", "message-1", "replacement body", version = 2),
            "\$physical-2",
            "\$root-a",
        )
        val exactDuplicate = projection.applyGatewayEvent(
            assistant("logical-event-1", "message-1", "must be ignored"),
            "\$physical-3",
            "\$root-a",
        )

        assertEquals("assistant:message-1:0", first.messages.single().eventId)
        assertEquals(first.messages.single().eventId, replay.messages.single().eventId)
        assertTrue(exactDuplicate.messages.isEmpty())
        assertFalse(exactDuplicate.changed)
    }

    @Test
    fun `older assistant message versions cannot truncate the latest text`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val latest = projection.applyGatewayEvent(
            assistant("logical-event-v2", "message-1", "这是一句完整的话", version = 2),
            "\$physical-v2",
            "\$root-a",
        )
        val stale = projection.applyGatewayEvent(
            assistant("logical-event-v1", "message-1", "这是", version = 1),
            "\$physical-v1",
            "\$root-a",
        )

        assertEquals("这是一句完整的话", latest.messages.single().text)
        assertTrue(stale.messages.isEmpty())
    }

    @Test
    fun `assistant message versions survive durable restore`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        original.applyGatewayEvent(
            assistant("logical-event-v3", "message-1", "complete", version = 3),
            "\$physical-v3",
            "\$root-a",
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )
        val stale = restored.applyGatewayEvent(
            assistant("logical-event-v2", "message-1", "truncated", version = 2),
            "\$physical-v2",
            "\$root-a",
        )

        assertTrue(stale.messages.isEmpty())
    }

    @Test
    fun `artifact assistant replacement completes the materialization command`() {
        val projection = projection()
        val result = projection.applyGatewayEvent(
            event(
                eventId = "artifact-materialized-1",
                projectId = "project-1",
                sessionId = "session-a",
                causationCommandId = "artifact-command-1",
                payload = buildJsonObject {
                    put("type", "assistant.message")
                    put("messageId", "message-1")
                    put("messageVersion", 2)
                    put("format", "markdown")
                    put("body", "[report](malink-artifact:reference-1)")
                    put("artifactReferences", buildJsonArray {
                        add(buildJsonObject {
                            put("id", "reference-1")
                            put("kind", "file")
                            put("name", "report.txt")
                            put("relativePath", "report.txt")
                            put("mimeType", "text/plain")
                            put("size", 6)
                            put("modifiedAt", 1)
                            put("statRevision", "revision-1")
                        })
                    })
                    put("attachments", buildJsonArray {
                        add(buildJsonObject {
                            put("id", "reference-1")
                            put("name", "report.txt")
                            put("mimeType", "text/plain")
                            put("size", 6)
                            put("sha256", "A".repeat(43))
                            put("media", buildJsonObject {
                                put("url", "mxc://example.org/report")
                                put("key", "B".repeat(43))
                                put("iv", "C".repeat(16))
                                put("sha256", "D".repeat(43))
                                put("size", 22)
                            })
                        })
                    })
                    put("ui", buildJsonObject {
                        put("kind", "artifact_materialization")
                        put("version", 1)
                        put("referenceId", "reference-1")
                        put("status", "materialized")
                    })
                },
            ),
            "\$artifact-physical",
            "\$root-a",
        )

        assertEquals("artifact-command-1", result.terminal?.commandId)
        assertEquals("succeeded", result.terminal?.outcome)
        assertEquals(
            "materialized",
            result.terminal?.result?.jsonObject?.get("status")?.jsonPrimitive?.content,
        )
        assertNull(result.taskNotification)
    }

    @Test
    fun `authoritative reconciliation progresses and completes the original command`() {
        val projection = projection()
        val running = projection.applyGatewayEvent(
            event(
                eventId = "reconciliation-running-1",
                projectId = "project-1",
                sessionId = "session-a",
                causationCommandId = "command-1",
                payload = buildJsonObject {
                    put("type", "command.reconciled")
                    put("commandId", "command-1")
                    put("state", "running")
                    put("acceptedAt", 1)
                    put("dispatchedAt", 2)
                },
            ),
            "\$reconciliation-running",
            "\$root-a",
        )
        assertEquals("command-1", running.progressedCommandId)
        assertNull(running.terminal)

        val terminal = projection.applyGatewayEvent(
            event(
                eventId = "reconciliation-terminal-1",
                projectId = "project-1",
                sessionId = "session-a",
                causationCommandId = "command-1",
                payload = buildJsonObject {
                    put("type", "command.reconciled")
                    put("commandId", "command-1")
                    put("state", "terminal")
                    put("acceptedAt", 1)
                    put("dispatchedAt", 2)
                    put("terminalAt", 3)
                    put("outcome", "interrupted")
                    put("error", buildJsonObject {
                        put("code", "execution_interrupted")
                        put("message", "The Gateway restarted after dispatch.")
                        put("retryable", true)
                    })
                },
            ),
            "\$reconciliation-terminal",
            "\$root-a",
        ).terminal
        assertEquals("command-1", terminal?.commandId)
        assertEquals("failed", terminal?.outcome)
        assertEquals("execution_interrupted", terminal?.errorCode)
        assertEquals(true, terminal?.retryable)
    }

    @Test
    fun `assistant message tool presentation is projected as a tool message`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val message = projection.applyGatewayEvent(
            assistantWithToolGroup(),
            "\$tool-message",
            "\$root-a",
        ).messages.single()

        assertEquals(ClientMessageKind.TOOL, message.kind)
        assertEquals("tool-call-1", message.toolGroup?.groupId)
        assertEquals(ToolCategory.READ, message.toolGroup?.tools?.single()?.category)
        assertEquals(ToolPhase.COMPLETED, message.toolGroup?.tools?.single()?.phase)
    }

    @Test
    fun `native tool activity is projected with a tool presentation`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val message = projection.applyGatewayEvent(
            toolActivity(),
            "\$tool-activity",
            "\$root-a",
        ).messages.single()

        assertEquals(ClientMessageKind.TOOL, message.kind)
        assertEquals("tool-call-2", message.toolGroup?.groupId)
        assertEquals("Search", message.toolGroup?.tools?.single()?.name)
        assertEquals(ToolCategory.UNKNOWN, message.toolGroup?.tools?.single()?.category)
    }

    @Test
    fun `durable projection restores current versions and thread roots`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 7, "Restored", 700),
            "\$root-a",
            "\$root-a",
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )

        assertEquals("\$root-a", restored.threadRootEventId("session-a"))
        assertEquals("Restored", sessionTitle(restored.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject))
        val duplicate = restored.applyGatewayEvent(
            sessionReady("session-a", 7, "Duplicate", 700),
            "\$duplicate",
            "\$duplicate",
        )
        assertFalse(duplicate.changed)
    }

    @Test
    fun `durable projection interns repeated session arrays`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        val availableCommands = buildJsonArray {
            repeat(40) { index ->
                add(buildJsonObject {
                    put("id", "command-$index")
                    put("name", "Command $index")
                    put("description", "description-$index-${"x".repeat(128)}")
                })
            }
        }
        repeat(300) { index ->
            projection.applyGatewayEvent(
                sessionReadyWithCommands("session-$index", index + 1L, availableCommands),
                "\$root-$index",
                "\$root-$index",
            )
        }

        val durable = projection.durableProjection()
        val encoded = durable.value.toString()
        assertEquals(1, Regex("description-39-").findAll(encoded).count())
        assertTrue(durable.encodedBytes < 1024 * 1024)

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = durable.value,
        )
        assertEquals("\$root-299", restored.threadRootEventId("session-299"))
    }

    @Test
    fun `schema twelve projection remains readable during direct codec upgrade`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 7, "Legacy", 700),
            "\$root-a",
            "\$root-a",
        )
        val current = projection.durableState()
        val catalogs = current.getValue("sessionArrayCatalogs").jsonObject
        val extensions = catalogs.getValue("extensions").jsonArray
        val commands = catalogs.getValue("availableCommands").jsonArray
        val legacySessions = current.getValue("sessions").jsonArray.map { element ->
            val session = element.jsonObject
            val extensionIndex = session.getValue("extensionsRef").jsonPrimitive.content.toInt()
            val commandIndex = session.getValue("availableCommandsRef").jsonPrimitive.content.toInt()
            JsonObject(
                session.filterKeys {
                    it != "extensionsRef" && it != "availableCommandsRef"
                } + mapOf(
                    "extensions" to extensions[extensionIndex],
                    "availableCommands" to commands[commandIndex],
                ),
            )
        }
        val legacy = JsonObject(
            current.filterKeys { it != "sessionArrayCatalogs" } + mapOf(
                "schemaVersion" to kotlinx.serialization.json.JsonPrimitive(12),
                "sessions" to JsonArray(legacySessions),
            ),
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = legacy,
        )

        assertEquals("\$root-a", restored.threadRootEventId("session-a"))
    }

    @Test
    fun `durable projection compacts unique rebuildable session data before cache limit`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        repeat(800) { index ->
            val uniqueCommands = buildJsonArray {
                add(buildJsonObject {
                    put("id", "command-$index")
                    put("name", "Command $index")
                    put("description", "$index-${"x".repeat(11_500)}")
                })
            }
            projection.applyGatewayEvent(
                sessionReadyWithCommands("session-$index", index + 1L, uniqueCommands),
                "\$root-$index",
                "\$root-$index",
            )
        }

        val durable = projection.durableProjection()
        assertTrue(durable.compacted)
        assertTrue(durable.retainedSessions < durable.totalSessions)
        assertTrue(durable.encodedBytes <= 6 * 1024 * 1024)

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = durable.value,
        )
        assertEquals("\$root-799", restored.threadRootEventId("session-799"))
        assertNull(restored.threadRootEventId("session-0"))
    }

    @Test
    fun `active turn id survives durable restore and clears on completion`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        original.applyGatewayEvent(turn("started", 2, "working"), "\$started-a", "\$root-a")

        val running = original.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("turn-1", running.getValue("active_turn_id").jsonPrimitive.content)
        assertEquals(2L, running.getValue("state_version").jsonPrimitive.content.toLong())

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )
        val restoredSession = restored.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject
        assertEquals("turn-1", restoredSession.getValue("active_turn_id").jsonPrimitive.content)

        restored.applyGatewayEvent(turn("completed", 3, "idle"), "\$completed-a", "\$root-a")
        val completed = restored.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
        assertFalse("active_turn_id" in completed)
        assertEquals(3L, completed.getValue("state_version").jsonPrimitive.content.toLong())
    }

    @Test
    fun `startup tail recovery targets active turns and applies their verified terminal`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(turn("started", 2, "working"), "\$started-a", "\$root-a")

        assertEquals(
            listOf(MatrixMlp3SessionTailRecoveryTarget(
                sessionId = "session-a",
                projectId = "project-1",
                threadRootEventId = "\$root-a",
                activeTurnId = "turn-1",
                stateVersion = 2,
            )),
            projection.activeSessionTailRecoveryTargets(64),
        )

        val result = projection.reconcileSessionTerminal(
            event = turn("completed", 3, "idle"),
            threadRootHint = "\$root-a",
            expectedSessionId = "session-a",
            expectedTurnId = "turn-1",
        )

        assertTrue(result.changed)
        assertEquals("turn-1", result.terminal?.commandId)
        assertTrue(projection.activeSessionTailRecoveryTargets(64).isEmpty())
        val completed = projection.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("idle", completed.getValue("status").jsonPrimitive.content)
        assertFalse("active_turn_id" in completed)
    }

    @Test
    fun `startup tail recovery cannot regress a newer active session`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(turn("started", 4, "working"), "\$started-a", "\$root-a")

        val result = projection.reconcileSessionTerminal(
            event = turn("completed", 3, "idle"),
            threadRootHint = "\$root-a",
            expectedSessionId = "session-a",
            expectedTurnId = "turn-1",
        )

        assertFalse(result.changed)
        assertNull(result.terminal)
        val running = projection.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("running", running.getValue("status").jsonPrimitive.content)
        assertEquals(4L, running.getValue("state_version").jsonPrimitive.content.toLong())
    }

    @Test
    fun `every authenticated turn terminal exposes one device independent notification`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(
            assistant(
                "assistant-final-1",
                "message-final-1",
                "Implemented the requested fix.",
                commandId = "turn-1",
                final = true,
            ),
            "\$assistant-final-1",
            "\$root-a",
        )
        val event = turn("completed", 2, "idle")

        val first = projection.applyGatewayEvent(event, "\$completed-a", "\$root-a")
        val duplicate = projection.applyGatewayEvent(event, "\$completed-a-replay", "\$root-a")

        assertEquals("turn-completed-2", first.taskNotification?.eventId)
        assertEquals("turn-1", first.taskNotification?.commandId)
        assertEquals("succeeded", first.taskNotification?.outcome)
        assertEquals("session-a", first.taskNotification?.sessionId)
        assertEquals("Implemented the requested fix.", first.taskNotification?.body)
        assertNull(duplicate.taskNotification)
    }

    @Test
    fun `final message notification preview survives durable projection restore`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        original.applyGatewayEvent(
            assistant(
                "assistant-final-restart",
                "message-final-restart",
                "Restart-safe final response.",
                commandId = "turn-1",
                final = true,
            ),
            "\$assistant-final-restart",
            "\$root-a",
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )
        val terminal = restored.applyGatewayEvent(
            turn("completed", 2, "idle"),
            "\$completed-after-restart",
            "\$root-a",
        )

        assertEquals("Restart-safe final response.", terminal.taskNotification?.body)
    }

    @Test
    fun `tool summaries never become the completed task notification body`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(
            assistantWithToolGroup(commandId = "turn-1", final = true),
            "\$tool-summary",
            "\$root-a",
        )

        val terminal = projection.applyGatewayEvent(
            turn("completed", 2, "idle"),
            "\$completed-after-tool",
            "\$root-a",
        )

        assertNull(terminal.taskNotification?.body)
    }

    @Test
    fun `failed turn exposes a failed task notification`() {
        val result = projection().applyGatewayEvent(
            event(
                eventId = "turn-failed-1",
                projectId = "project-1",
                sessionId = "session-a",
                causationCommandId = "remote-command-1",
                payload = buildJsonObject {
                    put("type", "turn.failed")
                    put("turnId", "turn-1")
                    put("code", "provider_failed")
                    put("message", "The provider failed.")
                },
            ),
            "\$failed-a",
            "\$root-a",
        )

        assertEquals("failed", result.taskNotification?.outcome)
        assertEquals("remote-command-1", result.taskNotification?.commandId)
        assertEquals("The provider failed.", result.taskNotification?.body)
    }

    @Test
    fun `a thread directory latest event can discover a session without its ready event`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionLifecycle("session-c", stateVersion = 4, lifecycle = "active"),
            "\$latest-c",
            "\$root-c",
        )

        assertEquals("\$root-c", projection.threadRootEventId("session-c"))
        assertEquals(
            listOf("session-c"),
            projection.snapshot()!!.getValue("sessions").jsonArray
                .map { it.jsonObject.getValue("id").jsonPrimitive.content },
        )
    }

    @Test
    fun `workspace capability catalog survives stale events and durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(2, "gpt-5.6-sol"), "\$workspace-2", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "stale-model"), "\$workspace-1", null)

        val model = projection.snapshot()!!
            .getValue("capabilities").jsonObject
            .getValue("models").jsonArray.single().jsonObject
            .getValue("id").jsonPrimitive.content
        assertEquals("gpt-5.6-sol", model)
        assertEquals(
            42L,
            projection.snapshot()!!
                .getValue("native_client_releases").jsonArray.single().jsonObject
                .getValue("versionCode").jsonPrimitive.content.toLong(),
        )
        assertEquals(
            "true",
            projection.snapshot()!!
                .getValue("capabilities").jsonObject
                .getValue("providers").jsonArray.single().jsonObject
                .getValue("can_materialize_history").jsonPrimitive.content,
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(
            "gpt-5.6-sol",
            restored.snapshot()!!
                .getValue("capabilities").jsonObject
                .getValue("models").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
        assertEquals(
            42L,
            restored.snapshot()!!
                .getValue("native_client_releases").jsonArray.single().jsonObject
                .getValue("versionCode").jsonPrimitive.content.toLong(),
        )
    }

    @Test
    fun `Gateway update status survives durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "gpt-5.6-sol"), "\$workspace", null)
        projection.applyGatewayEvent(
            event(
                eventId = "gateway-update-staged-1",
                projectId = "project-1",
                causationCommandId = "gateway-update-stage-1",
                payload = buildJsonObject {
                    put("type", "gateway.update.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "agent_running")
                        put("releaseId", "release-2")
                        put("targetBuildId", "build-2")
                        put("currentBuildId", "build-1")
                        put("activationMode", "forward-only")
                        put("maintenanceSessionId", "gateway-update-session-2")
                        put("updatedAt", 20)
                    })
                },
            ),
            "\$gateway-update-staged",
            null,
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        val status = restored.snapshot()!!.getValue("gateway_update").jsonObject
        assertEquals("agent_running", status.getValue("phase").jsonPrimitive.content)
        assertEquals("release-2", status.getValue("releaseId").jsonPrimitive.content)
        assertEquals("forward-only", status.getValue("activationMode").jsonPrimitive.content)
        assertEquals(
            "gateway-update-session-2",
            status.getValue("maintenanceSessionId").jsonPrimitive.content,
        )
    }

    @Test
    fun `signed Gateway status settles its exact maintenance session`() {
        val projection = projection()
        val maintenanceSessionId = "gateway-update-node-office-release-2"
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady(maintenanceSessionId, 1, "Gateway update", 100),
            "\$maintenance-root",
            "\$maintenance-root",
        )
        projection.applyGatewayEvent(
            event(
                eventId = "maintenance-working",
                projectId = "project-1",
                sessionId = maintenanceSessionId,
                causationCommandId = "maintenance-turn",
                payload = buildJsonObject {
                    put("type", "turn.started")
                    put("turnId", "maintenance-turn")
                    put(
                        "projection",
                        sessionProjection(2, "Gateway update", "active", "working", 200),
                    )
                },
            ),
            "\$maintenance-working",
            "\$maintenance-root",
        )
        projection.applyGatewayEvent(
            event(
                eventId = "maintenance-staged",
                projectId = "project-1",
                payload = buildJsonObject {
                    put("type", "gateway.update.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "staged")
                        put("releaseId", "release-2")
                        put("targetBuildId", "build-2")
                        put("currentBuildId", "build-1")
                        put("maintenanceSessionId", maintenanceSessionId)
                        put("updatedAt", 300)
                    })
                },
            ),
            "\$maintenance-staged",
            null,
        )

        val settled = projection.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject
        assertEquals("idle", settled.getValue("status").jsonPrimitive.content)
        assertEquals("idle", settled.getValue("activity_phase").jsonPrimitive.content)
        assertFalse("active_turn_id" in settled)
        assertEquals(300L, settled.getValue("updated_at").jsonPrimitive.content.toLong())

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        val restoredSession = restored.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject
        assertEquals("idle", restoredSession.getValue("activity_phase").jsonPrimitive.content)
        assertFalse("active_turn_id" in restoredSession)
    }

    @Test
    fun `Gateway retirement is a bounded terminal command result`() {
        val projection = projection()
        val applied = projection.applyGatewayEvent(
            event(
                eventId = "gateway-retired-1",
                projectId = "project-1",
                causationCommandId = "gateway-retire-command-1",
                payload = buildJsonObject {
                    put("type", "gateway.retired")
                    put("gatewayNodeId", "gateway-node-old")
                    put("removedProjectCount", 2)
                    put("directoryRevision", 8)
                },
            ),
            "\$gateway-retired",
            null,
        )

        assertEquals("gateway-retire-command-1", applied.terminal?.commandId)
        assertEquals("succeeded", applied.terminal?.outcome)
        assertEquals(
            "gateway-node-old",
            applied.terminal?.result?.jsonObject?.get("gatewayNodeId")?.jsonPrimitive?.content,
        )
        assertEquals(
            2,
            applied.terminal?.result?.jsonObject?.get("removedProjectCount")
                ?.jsonPrimitive?.content?.toInt(),
        )
        assertEquals(
            "8",
            applied.terminal?.result?.jsonObject?.get("directoryRevision")?.jsonPrimitive?.content,
        )
    }

    @Test
    fun `waiting for idle Gateway update progress is not a command terminal`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "gpt-5.6-sol"), "\$workspace", null)
        val waiting = projection.applyGatewayEvent(
            event(
                eventId = "gateway-update-waiting-1",
                projectId = "project-1",
                causationCommandId = "gateway-update-apply-1",
                payload = buildJsonObject {
                    put("type", "gateway.update.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "waiting_for_idle")
                        put("releaseId", "release-2")
                        put("targetBuildId", "build-2")
                        put("currentBuildId", "build-1")
                        put("activeTurns", 1)
                        put("updatedAt", 20)
                    })
                },
            ),
            "\$gateway-update-waiting",
            null,
        )

        assertNull(waiting.terminal)
        assertEquals(
            "waiting_for_idle",
            projection.snapshot()!!.getValue("gateway_update").jsonObject
                .getValue("phase").jsonPrimitive.content,
        )

        val scheduled = projection.applyGatewayEvent(
            event(
                eventId = "gateway-update-scheduled-1",
                projectId = "project-1",
                causationCommandId = "gateway-update-apply-1",
                payload = buildJsonObject {
                    put("type", "gateway.update.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "scheduled")
                        put("releaseId", "release-2")
                        put("targetBuildId", "build-2")
                        put("currentBuildId", "build-1")
                        put("updatedAt", 21)
                    })
                },
            ),
            "\$gateway-update-scheduled",
            null,
        )

        assertEquals("gateway-update-apply-1", scheduled.terminal?.commandId)
        assertEquals("succeeded", scheduled.terminal?.outcome)
    }

    @Test
    fun `Gateway restart progress completes only after it is scheduled`() {
        val projection = projection()
        val waiting = projection.applyGatewayEvent(
            event(
                eventId = "gateway-restart-waiting-1",
                projectId = "project-1",
                causationCommandId = "gateway-restart-1",
                payload = buildJsonObject {
                    put("type", "gateway.restart.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "waiting_for_idle")
                        put("mode", "when_idle")
                        put("activeTurns", 1)
                        put("updatedAt", 20)
                    })
                },
            ),
            "\$gateway-restart-waiting",
            null,
        )
        assertNull(waiting.terminal)

        val scheduled = projection.applyGatewayEvent(
            event(
                eventId = "gateway-restart-scheduled-1",
                projectId = "project-1",
                causationCommandId = "gateway-restart-1",
                payload = buildJsonObject {
                    put("type", "gateway.restart.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "scheduled")
                        put("restartId", "restart-1")
                        put("mode", "when_idle")
                        put("requestedAt", 21)
                        put("scheduledAt", 26)
                        put("updatedAt", 21)
                    })
                },
            ),
            "\$gateway-restart-scheduled",
            null,
        )
        assertEquals("gateway-restart-1", scheduled.terminal?.commandId)
        assertEquals("succeeded", scheduled.terminal?.outcome)
        assertEquals(
            "scheduled",
            scheduled.terminal?.result?.jsonObject?.get("phase")?.jsonPrimitive?.content,
        )
    }

    @Test
    fun `shared Gateway update observation survives durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyWorkspaceGatewayDirectory(buildJsonObject {
            put("directory", buildJsonObject {
                put("revision", 1)
                put("gateways", buildJsonArray {
                    add(buildJsonObject {
                        put("gatewayNodeId", "gateway-node-1")
                        put("projects", buildJsonArray {
                            add(buildJsonObject { put("projectId", "project-1") })
                        })
                    })
                })
            })
        })
        projection.applyGatewayEvent(
            event(
                eventId = "gateway-update-observation-1",
                projectId = "project-1",
                payload = buildJsonObject {
                    put("type", "gateway.update.status")
                    put("status", buildJsonObject {
                        put("version", 1)
                        put("phase", "committed")
                        put("currentBuildId", "build-2")
                        put("targetBuildId", "build-2")
                        put("updatedAt", 29)
                    })
                },
            ),
            "\$gateway-update-observation",
            null,
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        val status = restored.snapshot()!!
            .getValue("gateway_node_statuses").jsonObject
            .getValue("gateway-node-1").jsonObject
        assertEquals(1000L, status.getValue("observedAt").jsonPrimitive.content.toLong())
        assertEquals(
            "committed",
            status.getValue("update").jsonObject.getValue("phase").jsonPrimitive.content,
        )
    }

    @Test
    fun `new account release survives a lower version project capability snapshot`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            projectSnapshot("project-2", "Project Two", "/workspace/two"),
            "\$project-2",
            null,
        )
        projection.applyGatewayEvent(
            workspaceSnapshot(10, "project-a-model", 42),
            "\$workspace-a",
            null,
        )
        projection.applyGatewayEvent(
            workspaceSnapshot(1, "project-b-model", 43, "project-2"),
            "\$workspace-b",
            null,
        )

        val snapshot = projection.snapshot()!!
        assertEquals(
            "project-a-model",
            snapshot.getValue("capabilities").jsonObject
                .getValue("models").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
        val projectModels = snapshot.getValue("projects").jsonArray.associate { element ->
            val project = element.jsonObject
            project.getValue("project_id").jsonPrimitive.content to
                project.getValue("capabilities").jsonObject
                    .getValue("models").jsonArray.single().jsonObject
                    .getValue("id").jsonPrimitive.content
        }
        assertEquals(
            mapOf(
                "project-1" to "project-a-model",
                "project-2" to "project-b-model",
            ),
            projectModels,
        )
        assertEquals(
            43L,
            snapshot.getValue("native_client_releases").jsonArray.single().jsonObject
                .getValue("versionCode").jsonPrimitive.content.toLong(),
        )

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        val restoredProjectModels = restored.snapshot()!!
            .getValue("projects").jsonArray.associate { element ->
                val project = element.jsonObject
                project.getValue("project_id").jsonPrimitive.content to
                    project.getValue("capabilities").jsonObject
                        .getValue("models").jsonArray.single().jsonObject
                        .getValue("id").jsonPrimitive.content
            }
        assertEquals(projectModels, restoredProjectModels)
    }

    @Test
    fun `pending Gateway requests survive other Gateway snapshots and durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project-a", null)
        projection.applyGatewayEvent(
            projectSnapshot("project-2", "Project Two", "/workspace/two"),
            "\$project-b",
            null,
        )
        val pending = buildJsonArray {
            add(buildJsonObject {
                put("enrollmentId", "enrollment-1")
                put("gatewayNodeId", "gateway-node-new")
                put("gatewayName", "Studio Gateway")
                put("verificationCode", "123-456")
                put("requestedAt", 100)
                put("expiresAt", 10_000)
                put("approverProjectId", "project-1")
            })
        }
        projection.applyGatewayEvent(
            workspaceSnapshot(2, "project-a-model", pending = pending),
            "\$workspace-a",
            null,
        )
        projection.applyGatewayEvent(
            workspaceSnapshot(2, "project-b-model", projectId = "project-2"),
            "\$workspace-b",
            null,
        )

        assertEquals("enrollment-1", projection.pendingGatewayEnrollments().single()
            .jsonObject.getValue("enrollmentId").jsonPrimitive.content)
        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(1, restored.pendingGatewayEnrollments().size)

        restored.applyGatewayEvent(
            workspaceSnapshot(3, "project-a-model"),
            "\$workspace-a-cleared",
            null,
        )
        assertTrue(restored.pendingGatewayEnrollments().isEmpty())
    }

    @Test
    fun `projects extension capabilities defaults and declarative interactions`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        val interaction = projection.applyGatewayEvent(
            event(
                eventId = "extension-interaction-1",
                projectId = "project-1",
                sessionId = "session-a",
                payload = buildJsonObject {
                    put("type", "extension.interaction.requested")
                    put("requestId", "request-1")
                    put("extension", buildJsonObject {
                        put("id", "prefix-transform")
                        put("name", "Prefix transform")
                        put("version", "1")
                    })
                    put("cancelActionId", "cancel")
                    put("view", buildJsonObject {
                        put("version", 1)
                        put("title", "Review transformed input")
                        put("elements", JsonArray(emptyList()))
                        put("actions", buildJsonArray {
                            add(buildJsonObject { put("id", "continue"); put("label", "Continue") })
                            add(buildJsonObject { put("id", "cancel"); put("label", "Cancel") })
                        })
                    })
                    put("projection", sessionProjection(2, "Session A", "active", "attention", 200))
                },
            ),
            "\$interaction",
            "\$root-a",
        )

        assertEquals("request-1", interaction.messages.single().requestId)
        assertEquals(
            "prefix-transform",
            projection.snapshot()!!.getValue("capabilities").jsonObject
                .getValue("session_extensions").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
    }

    @Test
    fun `client integration descriptors survive the native authenticated projection`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            workspaceSnapshot(
                snapshotVersion = 1,
                model = "codex-test",
                includeClientIntegration = true,
            ),
            "\$workspace",
            null,
        )

        val integration = projection.snapshot()!!
            .getValue("capabilities").jsonObject
            .getValue("session_extensions").jsonArray.single().jsonObject
            .getValue("clientIntegration").jsonObject
        assertEquals(
            "https://app.metapp.example",
            integration.getValue("origin").jsonPrimitive.content,
        )
        assertEquals(
            "artifact.preview",
            integration.getValue("routes").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
    }

    @Test
    fun `scratch sessions and workspace inbox files survive durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady(
                "session-scratch",
                1,
                "Temporary",
                100,
                scope = "scratch",
                cwd = "/private/scratch/session",
            ),
            "\$scratch-root",
            "\$scratch-root",
        )
        projection.applyGatewayEvent(workspaceInboxFile(), "\$inbox-file", null)

        val snapshot = projection.snapshot()!!
        val session = snapshot.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("scratch", session.getValue("scope").jsonPrimitive.content)
        assertEquals("Temporary", session.getValue("project_name").jsonPrimitive.content)
        assertEquals(1, snapshot.getValue("inbox_files").jsonArray.size)

        val restored = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(1, restored.snapshot()!!.getValue("inbox_files").jsonArray.size)
    }

    private fun projection() = MatrixMlp3NativeProjection(
        gatewayId = { "gateway-1" },
        activeDeviceCount = { 2 },
    )

    private fun projectSnapshot(
        projectId: String = "project-1",
        name: String = "Project",
        cwd: String = "/workspace/project",
    ) = event(
        eventId = "project-snapshot-$projectId",
        projectId = projectId,
        payload = buildJsonObject {
            put("type", "project.snapshot")
            put("snapshotVersion", 1)
            put("name", name)
            put("cwd", cwd)
            put("provider", "codex")
            put("permissionMode", "default")
            put("installedExtensions", buildJsonArray {
                add(buildJsonObject {
                    put("id", "prefix-transform")
                    put("name", "Prefix transform")
                    put("description", "Adds a prefix")
                    put("version", "1")
                    put("settings", JsonArray(emptyList()))
                })
            })
            put("defaultExtensions", buildJsonArray {
                add(buildJsonObject { put("id", "prefix-transform") })
            })
            put("extensionDefaultsRevision", 2)
        },
    )

    private fun workspaceSnapshot(
        snapshotVersion: Long,
        model: String,
        releaseVersion: Long = 42,
        projectId: String = "project-1",
        pending: JsonArray = JsonArray(emptyList()),
        includeClientIntegration: Boolean = false,
        embeddedModels: Boolean = true,
    ) = event(
        eventId = "workspace-snapshot-$projectId-$snapshotVersion",
        projectId = projectId,
        payload = buildJsonObject {
            put("type", "workspace.snapshot")
            put("protocolMin", 3)
            put("protocolMax", 3)
            put("gatewayKeyId", "gateway-key-1")
            put("snapshotVersion", snapshotVersion)
            put("pendingGatewayEnrollments", pending)
            put("clientReleases", buildJsonArray {
                add(buildJsonObject {
                    put("platform", "android")
                    put("channel", "alpha")
                    put("architecture", "arm64-v8a")
                    put("packageName", "id.my.anciety.malink")
                    put("versionCode", releaseVersion)
                    put("versionName", "0.1.0-alpha.$releaseVersion")
                    put("buildId", "build-$releaseVersion")
                    put("publishedAt", releaseVersion)
                    put("minimumAndroid", 26)
                    put("nativeBridgeMinimum", 1)
                    put("nativeBridgeMaximum", 1)
                    put("importance", "recommended")
                    put("releaseNotes", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("Test release")) })
                    put("artifact", buildJsonObject {
                        put(
                            "url",
                            "https://rd.anciety.my.id/native-updates/releases/android/alpha/" +
                                "$releaseVersion/malink.apk",
                        )
                        put("size", 1_024)
                        put("sha256", "a".repeat(64))
                        put("signingCertificateSha256", "b".repeat(64))
                    })
                })
            })
            put("capabilities", buildJsonObject {
                put("models", buildJsonArray {
                    if (embeddedModels) {
                        add(buildJsonObject {
                            put("id", model)
                            put("name", model)
                            put("default_reasoning_level", "high")
                            put("supported_reasoning_levels", buildJsonArray {
                                add(buildJsonObject { put("effort", "high") })
                            })
                        })
                    }
                })
                put("providers", buildJsonArray {
                    add(buildJsonObject {
                        put("id", "codex")
                        put("name", "Codex")
                        put("models", buildJsonArray {
                            if (embeddedModels) {
                                add(buildJsonObject {
                                    put("id", model)
                                    put("name", model)
                                })
                            }
                        })
                        put("can_list_sessions", true)
                        put("can_inspect_sessions", true)
                        put("can_materialize_history", true)
                    })
                })
                put("permission_modes", buildJsonArray {
                    add(buildJsonObject { put("id", "default"); put("name", "Default") })
                })
                put("can_create_session", true)
                put("can_select_session", false)
                put("can_archive_session", true)
                put("can_delete_session", true)
                put("session_extensions", buildJsonArray {
                    if (includeClientIntegration) {
                        add(buildJsonObject {
                            put("id", "metapp")
                            put("name", "metapp")
                            put("description", "metapp client integration")
                            put("version", "1")
                            put("settings", buildJsonArray {})
                            put("clientIntegration", buildJsonObject {
                                put("origin", "https://app.metapp.example")
                                put("bridgeVersion", 1)
                                put("routes", buildJsonArray {
                                    add(buildJsonObject {
                                        put("id", "artifact.preview")
                                        put("path", "/embed/preview")
                                    })
                                })
                                put("capabilities", buildJsonArray {
                                    add(JsonPrimitive("host.close"))
                                })
                            })
                        })
                    }
                })
                put("web_push", buildJsonObject {
                    put("vapid_public_key", "B".repeat(87))
                })
            })
        },
    )

    private fun sessionReady(
        sessionId: String,
        stateVersion: Long,
        title: String,
        updatedAt: Long,
        scope: String = "project",
        cwd: String = "/workspace/project",
        projectId: String = "project-1",
        providerHistory: JsonObject? = null,
    ) = event(
        eventId = "ready-$sessionId-$stateVersion",
        projectId = projectId,
        sessionId = sessionId,
        causationCommandId = "create-$sessionId",
        payload = buildJsonObject {
            put("type", "session.ready")
            put("provider", "codex")
            put("permissionMode", "default")
            put("projection", sessionProjection(stateVersion, title, "active", "idle", updatedAt).let {
                JsonObject(it + mapOf(
                    "scope" to kotlinx.serialization.json.JsonPrimitive(scope),
                    "cwd" to kotlinx.serialization.json.JsonPrimitive(cwd),
                ) + if (providerHistory == null) emptyMap() else mapOf(
                    "providerHistory" to providerHistory,
                ))
            })
        },
    )

    private fun sessionCreateCommand(
        sessionId: String,
        title: String,
        projectId: String = "project-1",
    ) = buildJsonObject {
        put("commandId", "create-$sessionId")
        put("deviceId", "device-1")
        put("certificateId", "certificate-1")
        put("sessionId", sessionId)
        put("projectId", projectId)
        put("operation", "session.create")
        put("payload", buildJsonObject {
            put("title", title)
            put("initialPrompt", buildJsonObject { put("text", "Initial prompt") })
        })
    }

    private fun commandReconciledTerminal(
        sessionId: String,
        commandId: String,
    ) = event(
        eventId = "reconciled-$commandId",
        projectId = "project-1",
        sessionId = sessionId,
        causationCommandId = commandId,
        payload = buildJsonObject {
            put("type", "command.reconciled")
            put("commandId", commandId)
            put("state", "terminal")
            put("acceptedAt", 100)
            put("dispatchedAt", 200)
            put("terminalAt", 300)
            put("outcome", "succeeded")
        },
    )

    private fun providerCatalogPage(
        pageIndex: Int,
        modelId: String,
        projectId: String = "project-1",
        revision: String = "r".repeat(43),
        pageCount: Int = 2,
    ) = event(
        eventId = "provider-catalog-page-$projectId-$pageIndex-$revision",
        projectId = projectId,
        payload = buildJsonObject {
            put("type", "provider.catalog.page")
            put("providerId", "codex")
            put("catalog", "models")
            put("revision", revision)
            put("pageIndex", pageIndex)
            put("pageCount", pageCount)
            put("items", buildJsonArray {
                add(buildJsonObject {
                    put("id", modelId)
                    put("name", modelId)
                })
            })
        },
    )

    private fun providerCatalogManifest(
        itemCount: Int,
        pageCount: Int,
        projectId: String = "project-1",
        revision: String = "r".repeat(43),
    ) = event(
        eventId = "provider-catalog-manifest-$projectId-$revision",
        projectId = projectId,
        payload = buildJsonObject {
            put("type", "provider.catalog.manifest")
            put("providerId", "codex")
            put("catalog", "models")
            put("revision", revision)
            put("status", "ready")
            put("itemCount", itemCount)
            put("pageCount", pageCount)
        },
    )

    private fun sessionReadyWithCommands(
        sessionId: String,
        stateVersion: Long,
        availableCommands: JsonArray,
    ) = event(
        eventId = "ready-$sessionId-$stateVersion",
        projectId = "project-1",
        sessionId = sessionId,
        causationCommandId = "create-$sessionId",
        payload = buildJsonObject {
            put("type", "session.ready")
            put("provider", "codex")
            put("permissionMode", "default")
            put("projection", JsonObject(sessionProjection(
                stateVersion,
                "Session $sessionId",
                "active",
                "idle",
                stateVersion,
            ) + ("availableCommands" to availableCommands)))
        },
    )

    private fun workspaceInboxFile() = event(
        eventId = "workspace-inbox-file-1",
        projectId = "project-1",
        payload = buildJsonObject {
            put("type", "inbox.file.received")
            put("fileId", "workspace-file-1")
            put("caption", "Generated report")
            put("source", buildJsonObject {
                put("kind", "local-cli")
                put("label", "review-agent")
            })
            put("attachment", buildJsonObject {
                put("id", "attachment-1")
                put("name", "report.pdf")
                put("mimeType", "application/pdf")
                put("size", 12)
                put("sha256", "A".repeat(43))
                put("media", buildJsonObject {
                    put("url", "mxc://example.org/report")
                    put("key", "B".repeat(43))
                    put("iv", "C".repeat(16))
                    put("sha256", "D".repeat(43))
                    put("size", 28)
                })
            })
        },
    )

    private fun sessionLifecycle(
        sessionId: String,
        stateVersion: Long,
        lifecycle: String,
    ) = event(
        eventId = "lifecycle-$sessionId-$stateVersion",
        projectId = "project-1",
        sessionId = sessionId,
        causationCommandId = "delete-$sessionId",
        payload = buildJsonObject {
            put("type", "session.lifecycle")
            put("state", lifecycle)
            put("projection", sessionProjection(stateVersion, "Newest A", lifecycle, "idle", 600))
        },
    )

    private fun assistant(
        eventId: String,
        messageId: String,
        body: String,
        version: Int = 1,
        commandId: String? = null,
        final: Boolean = false,
    ) = event(
        eventId = eventId,
        projectId = "project-1",
        sessionId = "session-a",
        causationCommandId = commandId,
        payload = buildJsonObject {
            put("type", "assistant.message")
            put("messageId", messageId)
            put("messageVersion", version)
            put("partIndex", 0)
            put("format", "markdown")
            put("body", body)
            put("final", final)
        },
    )

    private fun assistantWithToolGroup(
        commandId: String? = null,
        final: Boolean = false,
    ) = event(
        eventId = "tool-message-event-1",
        projectId = "project-1",
        sessionId = "session-a",
        causationCommandId = commandId,
        payload = buildJsonObject {
            put("type", "assistant.message")
            put("messageId", "tool-message-1")
            put("messageVersion", 1)
            put("partIndex", 0)
            put("format", "plain")
            put("body", "Read file")
            put("final", final)
            put("ui", buildJsonObject {
                put("kind", "tool_group")
                put("version", 1)
                put("groupId", "tool-call-1")
                put("tools", buildJsonArray {
                    add(buildJsonObject {
                        put("id", "tool-call-1")
                        put("name", "Read")
                        put("title", "Read file")
                        put("detail", "/workspace/file.ts")
                        put("category", "read")
                        put("phase", "completed")
                        put("isError", false)
                        put("startedAt", 990)
                        put("updatedAt", 1000)
                    })
                })
            })
        },
    )

    private fun toolActivity() = event(
        eventId = "tool-activity-event-1",
        projectId = "project-1",
        sessionId = "session-a",
        payload = buildJsonObject {
            put("type", "tool.activity")
            put("toolCallId", "tool-call-2")
            put("toolVersion", 1)
            put("name", "Search")
            put("phase", "started")
            put("projection", sessionProjection(2, "Session A", "active", "working", 200))
        },
    )

    private fun turn(stage: String, stateVersion: Long, activity: String) = event(
        eventId = "turn-$stage-$stateVersion",
        projectId = "project-1",
        sessionId = "session-a",
        causationCommandId = "turn-1",
        payload = buildJsonObject {
            put("type", "turn.$stage")
            put("turnId", "turn-1")
            if (stage == "completed") put("outcome", "succeeded")
            put(
                "projection",
                sessionProjection(stateVersion, "Session A", "active", activity, stateVersion * 100),
            )
        },
    )

    private fun sessionProjection(
        stateVersion: Long,
        title: String,
        lifecycle: String,
        activity: String,
        updatedAt: Long,
    ) = buildJsonObject {
        put("stateVersion", stateVersion)
        put("title", title)
        put("lifecycle", lifecycle)
        put("activity", activity)
        put("updatedAt", updatedAt)
        put("extensions", buildJsonArray {
            add(buildJsonObject {
                put("id", "prefix-transform")
                put("name", "Prefix transform")
                put("version", "1")
            })
        })
        put("extensionRevision", 1)
    }

    private fun event(
        eventId: String,
        projectId: String,
        payload: JsonObject,
        sessionId: String? = null,
        causationCommandId: String? = null,
    ) = buildJsonObject {
        put("kind", "malink.event")
        put("version", 3)
        put("eventId", eventId)
        put("workspaceId", "workspace-1")
        put("projectId", projectId)
        sessionId?.let { put("sessionId", it) }
        causationCommandId?.let { put("causationCommandId", it) }
        put("occurredAt", 1000)
        put("payload", payload)
    }

    private fun sessionTitle(session: JsonObject) = session.getValue("title").jsonPrimitive.content
}
