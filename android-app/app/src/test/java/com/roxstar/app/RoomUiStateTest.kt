package com.roxstar.app

import com.roxstar.app.data.api.ParticipantDto
import com.roxstar.app.data.api.SpinDto
import com.roxstar.app.data.api.SpinParticipantDto
import com.roxstar.app.ui.RoomUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Client-side spin gating.
 *
 * These rules mirror the server's, purely so the button can be disabled with a
 * reason instead of firing a request that will be refused. The server stays
 * the authority -- that is asserted here too, by checking the client never
 * enables Start for someone who lacks the role.
 */
class RoomUiStateTest {

    private fun participant(
        id: String,
        role: String = "MEMBER",
        connected: Boolean = true,
    ) = ParticipantDto(
        userId = id,
        displayName = "User $id",
        role = role,
        connectionStatus = if (connected) "CONNECTED" else "DISCONNECTED",
        joinedAt = "2026-01-01T00:00:00.000Z",
    )

    private fun spin(status: String) = SpinDto(
        spinId = "spin-1",
        roomId = "room-1",
        status = status,
        startedBy = "owner",
        startedAt = "2026-01-01T00:00:00.000Z",
        completedAt = null,
        winner = null,
        abortReason = null,
        eliminationIntervalMs = 5000,
        nextEliminationAt = null,
        participants = emptyList(),
        remainingParticipants = emptyList(),
        eliminatedParticipants = emptyList(),
    )

    @Test
    fun `owner with three players can start`() {
        val state = RoomUiState(
            currentUserId = "owner",
            participants = listOf(
                participant("owner", role = "OWNER"),
                participant("b"),
                participant("c"),
            ),
        )

        assertTrue(state.canStartSpin)
        assertNull(state.spinBlockedReason)
    }

    @Test
    fun `plain member cannot start even with enough players`() {
        val state = RoomUiState(
            currentUserId = "b",
            participants = listOf(
                participant("owner", role = "OWNER"),
                participant("b"),
                participant("c"),
            ),
        )

        assertFalse(state.canStartSpin)
        assertEquals("Only the room owner or an admin can start a spin.", state.spinBlockedReason)
    }

    @Test
    fun `admin can start`() {
        val state = RoomUiState(
            currentUserId = "b",
            participants = listOf(
                participant("owner", role = "OWNER"),
                participant("b", role = "ADMIN"),
                participant("c"),
            ),
        )

        assertTrue(state.canStartSpin)
        assertNull(state.spinBlockedReason)
    }

    @Test
    fun `two players is not enough`() {
        val state = RoomUiState(
            currentUserId = "owner",
            participants = listOf(participant("owner", role = "OWNER"), participant("b")),
        )

        assertEquals("Need at least 3 players (currently 2).", state.spinBlockedReason)
    }

    @Test
    fun `twenty one players is too many`() {
        val state = RoomUiState(
            currentUserId = "owner",
            participants = buildList {
                add(participant("owner", role = "OWNER"))
                repeat(20) { add(participant("p$it")) }
            },
        )

        assertEquals("Too many players: 21 (maximum 20).", state.spinBlockedReason)
    }

    @Test
    fun `exactly twenty players is allowed`() {
        val state = RoomUiState(
            currentUserId = "owner",
            participants = buildList {
                add(participant("owner", role = "OWNER"))
                repeat(19) { add(participant("p$it")) }
            },
        )

        assertNull(state.spinBlockedReason)
    }

    @Test
    fun `a running spin blocks a second start`() {
        val state = RoomUiState(
            currentUserId = "owner",
            participants = listOf(
                participant("owner", role = "OWNER"),
                participant("b"),
                participant("c"),
            ),
            spin = spin("RUNNING"),
        )

        assertEquals("A spin is already running.", state.spinBlockedReason)
    }

    @Test
    fun `a finished spin does not block a new one`() {
        val state = RoomUiState(
            currentUserId = "owner",
            participants = listOf(
                participant("owner", role = "OWNER"),
                participant("b"),
                participant("c"),
            ),
            spin = spin("COMPLETED"),
        )

        assertNull(state.spinBlockedReason)
    }

    @Test
    fun `a disconnected member still counts as eligible`() {
        // D13: a dropped socket is not a departure. Excluding them here would
        // disagree with the server, which is the one building the roster.
        val state = RoomUiState(
            currentUserId = "owner",
            participants = listOf(
                participant("owner", role = "OWNER"),
                participant("b", connected = false),
                participant("c"),
            ),
        )

        assertEquals(3, state.eligibleCount)
        assertNull(state.spinBlockedReason)
    }
}

/** Sanity checks on the SpinDto helpers the UI branches on. */
class SpinDtoTest {

    private fun spin(status: String, remaining: Int = 0, eliminated: Int = 0) = SpinDto(
        spinId = "s",
        roomId = "r",
        status = status,
        startedBy = null,
        startedAt = null,
        completedAt = null,
        winner = null,
        abortReason = null,
        eliminationIntervalMs = 5000,
        nextEliminationAt = null,
        participants = emptyList(),
        remainingParticipants = List(remaining) {
            SpinParticipantDto("u$it", "U$it", "ACTIVE", null, null)
        },
        eliminatedParticipants = List(eliminated) {
            SpinParticipantDto("e$it", "E$it", "ELIMINATED", it + 1, null)
        },
    )

    @Test
    fun `isRunning is true only while RUNNING`() {
        assertTrue(spin("RUNNING").isRunning)
        assertFalse(spin("WAITING").isRunning)
        assertFalse(spin("COMPLETED").isRunning)
        assertFalse(spin("ABORTED").isRunning)
    }

    @Test
    fun `isFinished covers both terminal states`() {
        assertTrue(spin("COMPLETED").isFinished)
        assertTrue(spin("ABORTED").isFinished)
        assertFalse(spin("RUNNING").isFinished)
    }
}
