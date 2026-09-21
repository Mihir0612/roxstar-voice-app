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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.roxstar.app.data.local.DraftEntity
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
    /** The caller must pass the local DraftEntity that matches the shared draft (or null). */
    localSharedDraft: DraftEntity? = null,
    onPlaySharedDraft: () -> Unit = {},
    onStopSharedDraftPlayback: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    androidx.compose.foundation.layout.Box(modifier = modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {

            state.error?.let { ErrorBanner(message = it, onDismiss = onDismissError) }

            if (!state.isInRoom) {
                Lobby(isLoading = state.isLoading, onCreateRoom = onCreateRoom, onJoinRoom = onJoinRoom)
                return@Column
            }

            RoomHeader(state = state, onLeaveRoom = onLeaveRoom, onRefresh = onRefresh)

            Spacer(Modifier.height(16.dp))

            SectionHeader("Participants (${state.participants.size})")
            state.participants.forEach { participant ->
                val isEliminated = state.spin?.eliminatedParticipants?.any { it.userId == participant.userId } == true
                ParticipantRow(participant, isSelf = participant.userId == state.currentUserId, isEliminated = isEliminated)
            }

            Spacer(Modifier.height(16.dp))

            SharedDraftCard(
                state = state,
                localDraft = localSharedDraft,
                onPlay = onPlaySharedDraft,
                onStop = onStopSharedDraftPlayback,
            )

            Spacer(Modifier.height(16.dp))

            SpinSection(
                state = state,
                onStartSpin = onStartSpin,
            )

            Spacer(Modifier.height(16.dp))

            ActivityFeed(state.activity)
        }

        if (state.spin?.status == "COMPLETED" && state.spin?.winner != null) {
            FirecrackersAnimation()
        }
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
private fun ParticipantRow(participant: ParticipantDto, isSelf: Boolean, isEliminated: Boolean = false) {
    val alpha = if (isEliminated) 0.35f else 1.0f

    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StatusDot(connected = participant.isConnected)
        Text(
            participant.displayName + (if (isSelf) " (you)" else "") + (if (isEliminated) " ✖ (Eliminated)" else ""),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (isEliminated) FontWeight.Normal else FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha),
            modifier = Modifier.weight(1f),
        )
        if (participant.role != "MEMBER") {
            Text(
                participant.role,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha),
            )
        }
        if (isEliminated) {
            Text(
                "Out",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error.copy(alpha = 0.7f),
            )
        } else if (!participant.isConnected) {
            Text(
                "reconnecting",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SharedDraftCard(
    state: RoomUiState,
    localDraft: DraftEntity?,
    onPlay: () -> Unit,
    onStop: () -> Unit,
) {
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

    val audioAvailable = localDraft?.exists == true

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {

            // Header row: draft name + play/stop button
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    shared.draft.name,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                // Play/Stop button — only truly active when this device holds the WAV.
                IconButton(
                    onClick = if (state.isPlayingSharedDraft) onStop else onPlay,
                    enabled = audioAvailable || state.isPlayingSharedDraft,
                ) {
                    Icon(
                        imageVector = if (state.isPlayingSharedDraft) Icons.Default.Stop else Icons.Default.PlayArrow,
                        contentDescription = if (state.isPlayingSharedDraft) "Stop playback" else "Listen to shared draft",
                        tint = if (audioAvailable) MaterialTheme.colorScheme.primary
                               else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            KeyValue("Effect", shared.draft.effect)
            KeyValue("Duration", "${shared.draft.durationMs / 1000}s")
            KeyValue(
                "Shared by",
                state.participants.firstOrNull { it.userId == shared.sharedBy }?.displayName ?: "Unknown",
            )
            Spacer(Modifier.height(6.dp))
            Text(
                if (audioAvailable) {
                    "Tap ▶ to listen. Audio plays from your local recording."
                } else {
                    // Being explicit prevents the reasonable assumption that other
                    // people can hear it (D10).
                    "Audio is stored on the recording device. Only the details above are shared with the room."
                },
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
                    SpinWheelCanvas(
                        participants = spin.participants,
                        isRunning = false,
                        winnerUserId = spin.winner?.userId,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text("🎉 WINNER 🎉", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    Text(
                        spin.winner?.displayName ?: "Unknown",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
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
    Text("Spin wheel running...", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
    Text(
        "One player is eliminated every ${spin.eliminationIntervalMs / 1000} seconds. Eliminated players are dimmed and excluded from future spins.",
        style = MaterialTheme.typography.labelSmall,
    )

    Spacer(Modifier.height(8.dp))

    SpinWheelCanvas(
        participants = spin.participants,
        isRunning = true,
    )

    Spacer(Modifier.height(12.dp))

    Text("Still in round (${spin.remainingParticipants.size})", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
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
