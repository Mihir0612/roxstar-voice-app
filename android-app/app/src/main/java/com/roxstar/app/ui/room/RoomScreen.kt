package com.roxstar.app.ui.room

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.roxstar.app.data.api.ParticipantDto
import com.roxstar.app.data.api.SpinDto
import com.roxstar.app.ui.RoomUiState
import com.roxstar.app.ui.components.ConnectionPill
import com.roxstar.app.ui.components.ErrorBanner
import com.roxstar.app.ui.components.KeyValue
import com.roxstar.app.ui.components.SectionHeader
import com.roxstar.app.ui.components.StatusDot

/**
 * Room screen: lobby when not in a room, live room view when in one.
 *
 * Everything rendered here comes from the server. The spin section in
 * particular never computes anything -- no local countdown, no local
 * elimination, no local winner. It draws `state.spin` and nothing else.
 */
@Composable
fun RoomScreen(
    state: RoomUiState,
    onCreateRoom: (String) -> Unit,
    onJoinRoom: (String) -> Unit,
    onLeaveRoom: () -> Unit,
    onStartSpin: () -> Unit,
    onRefresh: () -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {

        state.error?.let { ErrorBanner(message = it, onDismiss = onDismissError) }

        if (!state.isInRoom) {
            Lobby(isLoading = state.isLoading, onCreateRoom = onCreateRoom, onJoinRoom = onJoinRoom)
            return@Column
        }

        RoomHeader(state = state, onLeaveRoom = onLeaveRoom, onRefresh = onRefresh)

        Spacer(Modifier.height(16.dp))

        SectionHeader("Participants (${state.participants.size})")
        state.participants.forEach { ParticipantRow(it, isSelf = it.userId == state.currentUserId) }

        Spacer(Modifier.height(16.dp))

        SharedDraftCard(state)

        Spacer(Modifier.height(16.dp))

        SpinSection(
            state = state,
            onStartSpin = onStartSpin,
        )

        Spacer(Modifier.height(16.dp))

        ActivityFeed(state.activity)
    }
}

@Composable
private fun Lobby(
    isLoading: Boolean,
    onCreateRoom: (String) -> Unit,
    onJoinRoom: (String) -> Unit,
) {
    var roomName by remember { mutableStateOf("My Roxstar Room") }
    var joinCode by remember { mutableStateOf("") }

    SectionHeader("Create a room")
    OutlinedTextField(
        value = roomName,
        onValueChange = { roomName = it },
        label = { Text("Room name") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    Button(
        onClick = { onCreateRoom(roomName) },
        enabled = !isLoading && roomName.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (isLoading) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        } else {
            Text("Create room")
        }
    }

    Spacer(Modifier.height(28.dp))

    SectionHeader("Join with a code")
    OutlinedTextField(
        value = joinCode,
        // Codes are uppercase on the server; normalising here avoids a
        // confusing 404 when someone types lowercase.
        onValueChange = { joinCode = it.uppercase().take(36) },
        label = { Text("6-character code") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    OutlinedButton(
        onClick = { onJoinRoom(joinCode) },
        enabled = !isLoading && joinCode.length >= 4,
        modifier = Modifier.fillMaxWidth(),
    ) { Text("Join room") }
}

@Composable
private fun RoomHeader(state: RoomUiState, onLeaveRoom: () -> Unit, onRefresh: () -> Unit) {
    val room = state.room ?: return

    Card {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(room.name, style = MaterialTheme.typography.titleLarge)
                    Text(
                        "Code ${room.code}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }
                ConnectionPill(state.connection)
            }

            Spacer(Modifier.height(12.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRefresh) { Text("Refresh state") }
                OutlinedButton(onClick = onLeaveRoom) { Text("Leave") }
            }

            if (state.spin?.isRunning == true) {
                Spacer(Modifier.height(8.dp))
                Text(
                    // D11 made plain: the user should know before tapping Leave.
                    "Leaving during a spin forfeits your place.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
        }
    }
}

@Composable
private fun ParticipantRow(participant: ParticipantDto, isSelf: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StatusDot(connected = participant.isConnected)
        Text(
            participant.displayName + if (isSelf) " (you)" else "",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        if (participant.role != "MEMBER") {
            Text(participant.role, style = MaterialTheme.typography.labelSmall)
        }
        if (!participant.isConnected) {
            // Distinguishes "gone" from "reconnecting" (D13) while the grace
            // period is still running.
            Text(
                "reconnecting",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SharedDraftCard(state: RoomUiState) {
    SectionHeader("Shared draft")

    val shared = state.sharedDraft
    if (shared == null) {
        Text(
            "Nothing shared yet. Record a draft and share it from the Studio tab.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Text(shared.draft.name, fontWeight = FontWeight.SemiBold)
            KeyValue("Effect", shared.draft.effect)
            KeyValue("Duration", "${shared.draft.durationMs / 1000}s")
            KeyValue(
                "Shared by",
                state.participants.firstOrNull { it.userId == shared.sharedBy }?.displayName ?: "Unknown",
            )
            Spacer(Modifier.height(6.dp))
            Text(
                // Being explicit prevents the reasonable assumption that other
                // people can hear it (D10).
                "Audio stays on the recording device. Only the details above are shared.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SpinSection(state: RoomUiState, onStartSpin: () -> Unit) {
    SectionHeader("Spin wheel")

    val spin = state.spin

    Card {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {

            when {
                spin == null -> Text(
                    "No spin yet. The room owner can start one with 3 to 20 players.",
                    style = MaterialTheme.typography.bodyMedium,
                )

                spin.isRunning -> RunningSpin(spin, state)

                spin.status == "COMPLETED" -> {
                    Text("Winner", style = MaterialTheme.typography.labelSmall)
                    Text(
                        spin.winner?.displayName ?: "Unknown",
                        style = MaterialTheme.typography.headlineMedium,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    Spacer(Modifier.height(8.dp))
                    EliminationOrder(spin)
                }

                spin.status == "ABORTED" -> {
                    Text("Spin aborted", style = MaterialTheme.typography.titleLarge)
                    Text(
                        when (spin.abortReason) {
                            "NO_PARTICIPANTS" -> "Everyone left before a winner could be decided."
                            "ROOM_CLOSED" -> "The room was closed."
                            else -> "The spin was stopped."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            Spacer(Modifier.height(14.dp))

            Button(
                onClick = onStartSpin,
                enabled = state.spinBlockedReason == null && !state.isLoading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (spin?.isRunning == true) "Spin in progress" else "Start spin") }

            // The button being disabled is not self-explanatory, so say why.
            // The server still decides; this only saves a pointless round-trip.
            state.spinBlockedReason?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
            }
        }
    }
}

@Composable
private fun RunningSpin(spin: SpinDto, state: RoomUiState) {
    Text("Spin running", style = MaterialTheme.typography.titleLarge)
    Text(
        "One player is eliminated every ${spin.eliminationIntervalMs / 1000} seconds.",
        style = MaterialTheme.typography.labelSmall,
    )

    Spacer(Modifier.height(12.dp))

    Text("Still in (${spin.remainingParticipants.size})", style = MaterialTheme.typography.labelSmall)
    spin.remainingParticipants.forEach { p ->
        Text(
            p.displayName + if (p.userId == state.currentUserId) " (you)" else "",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (p.userId == state.currentUserId) FontWeight.Bold else FontWeight.Normal,
        )
    }

    if (spin.eliminatedParticipants.isNotEmpty()) {
        Spacer(Modifier.height(10.dp))
        EliminationOrder(spin)
    }
}

@Composable
private fun EliminationOrder(spin: SpinDto) {
    Text("Eliminated", style = MaterialTheme.typography.labelSmall)
    spin.eliminatedParticipants.forEach { p ->
        Text(
            // "forfeited" vs "eliminated" comes straight from the server's
            // status (D11) -- the client does not infer it.
            "${p.eliminationOrder}. ${p.displayName}" + if (p.status == "LEFT") " (forfeited)" else "",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ActivityFeed(activity: List<String>) {
    if (activity.isEmpty()) return

    SectionHeader("Activity")
    LazyColumn(Modifier.heightIn(max = 220.dp)) {
        items(activity.reversed()) { line ->
            Text(
                line,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(vertical = 3.dp),
            )
        }
    }
}
