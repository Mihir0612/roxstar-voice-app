package com.roxstar.app.ui.audio

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.roxstar.app.audio.AudioEffect
import com.roxstar.app.audio.RecordingState
import com.roxstar.app.data.local.DraftEntity
import com.roxstar.app.ui.AudioViewModel
import com.roxstar.app.ui.components.ErrorBanner
import com.roxstar.app.ui.components.SectionHeader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Audio Studio: record with an effect, then manage local drafts.
 *
 * The screen reflects the recorder's state machine directly -- there is no
 * second source of truth about whether recording is in progress, which is what
 * keeps the buttons honest when a stream drops mid-take.
 */
@Composable
fun AudioScreen(
    viewModel: AudioViewModel,
    onShareDraft: (DraftEntity) -> Unit,
    canShare: Boolean,
    modifier: Modifier = Modifier,
) {
    val ui by viewModel.ui.collectAsState()
    val recording by viewModel.recordingState.collectAsState()
    val drafts by viewModel.drafts.collectAsState()

    // A finished take prompts for a name rather than saving silently, so the
    // draft list stays meaningful after a dozen recordings.
    LaunchedEffect(recording) {
        if (recording is RecordingState.Saved) viewModel.onRecordingSaved(recording as RecordingState.Saved)
    }

    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {

        ui.error?.let { ErrorBanner(message = it, onDismiss = viewModel::dismissError) }

        (recording as? RecordingState.Failed)?.let { failed ->
            ErrorBanner(message = failed.reason.message, onDismiss = viewModel::cancelRecording)
        }

        SectionHeader("Voice effect")

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            AudioEffect.entries.forEach { effect ->
                FilterChip(
                    selected = ui.selectedEffect == effect,
                    // Changing the effect mid-take would need the native engine
                    // to swap its delay line under the audio thread. Not worth
                    // the risk for a feature nobody asked for.
                    onClick = { if (recording !is RecordingState.Recording) viewModel.selectEffect(effect) },
                    enabled = recording !is RecordingState.Recording,
                    label = { Text(effect.label, maxLines = 2) },
                )
            }
        }

        Spacer(Modifier.height(20.dp))

        RecorderPanel(
            recording = recording,
            onStart = viewModel::startRecording,
            onStop = viewModel::stopRecording,
            onCancel = viewModel::cancelRecording,
        )

        Spacer(Modifier.height(24.dp))

        SectionHeader("Drafts (${drafts.size})")

        if (drafts.isEmpty()) {
            EmptyDrafts()
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(drafts, key = { it.draftId }) { draft ->
                    DraftRow(
                        draft = draft,
                        isPlaying = ui.playingDraftId == draft.draftId,
                        canShare = canShare,
                        onPlay = { viewModel.playDraft(draft) },
                        onStop = viewModel::stopPlayback,
                        onDelete = { viewModel.deleteDraft(draft) },
                        onShare = { onShareDraft(draft) },
                    )
                }
            }
        }
    }

    ui.pendingSave?.let { pending ->
        SaveDraftDialog(
            durationMs = pending.durationMs,
            effectLabel = pending.effect.label,
            onConfirm = viewModel::confirmSave,
            onDiscard = viewModel::discardPendingSave,
        )
    }
}

@Composable
private fun RecorderPanel(
    recording: RecordingState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onCancel: () -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when (recording) {
                is RecordingState.Recording -> {
                    Text(
                        formatDuration(recording.durationMs),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text("Recording with ${recording.effect.label}", style = MaterialTheme.typography.labelSmall)
                    Spacer(Modifier.height(12.dp))

                    // Live peak level -- proves the microphone is actually
                    // delivering audio rather than silently failing.
                    LinearProgressIndicator(
                        progress = { recording.level.coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().height(6.dp),
                    )

                    Spacer(Modifier.height(16.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(onClick = onStop) {
                            Icon(Icons.Default.Stop, contentDescription = null)
                            Spacer(Modifier.size(6.dp))
                            Text("Stop & save")
                        }
                        OutlinedButton(onClick = onCancel) { Text("Cancel") }
                    }
                }

                RecordingState.Stopping -> {
                    Text("Finishing recording...", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }

                else -> {
                    Button(onClick = onStart) {
                        Icon(Icons.Default.Mic, contentDescription = null)
                        Spacer(Modifier.size(8.dp))
                        Text("Start recording")
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Captured through Oboe with the effect applied in the native path.",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun DraftRow(
    draft: DraftEntity,
    isPlaying: Boolean,
    canShare: Boolean,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onDelete: () -> Unit,
    onShare: () -> Unit,
) {
    Card {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = if (isPlaying) onStop else onPlay) {
                Icon(
                    if (isPlaying) Icons.Default.Stop else Icons.Default.PlayArrow,
                    contentDescription = if (isPlaying) "Stop" else "Play ${draft.name}",
                )
            }

            Column(Modifier.weight(1f)) {
                Text(draft.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "${formatDuration(draft.durationMs)} - ${draft.effect} - ${formatDate(draft.createdAt)}",
                    style = MaterialTheme.typography.labelSmall,
                )
                if (!draft.exists) {
                    Text(
                        "File missing",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                draft.sharedAt?.let {
                    AssistChip(onClick = {}, label = { Text("Shared", style = MaterialTheme.typography.labelSmall) })
                }
            }

            AnimatedVisibility(visible = canShare) {
                IconButton(onClick = onShare, enabled = draft.exists) {
                    Icon(Icons.Default.Share, contentDescription = "Share ${draft.name} with the room")
                }
            }

            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Delete ${draft.name}")
            }
        }
    }
}

@Composable
private fun EmptyDrafts() {
    Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) {
        Text(
            "No drafts yet. Record something to get started.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SaveDraftDialog(
    durationMs: Long,
    effectLabel: String,
    onConfirm: (String) -> Unit,
    onDiscard: () -> Unit,
) {
    var name by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDiscard,
        title = { Text("Save this take?") },
        text = {
            Column {
                Text("${formatDuration(durationMs)} recorded with $effectLabel.")
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Draft name") },
                    singleLine = true,
                )
            }
        },
        confirmButton = { Button(onClick = { onConfirm(name) }) { Text("Save draft") } },
        dismissButton = { TextButton(onClick = onDiscard) { Text("Discard") } },
    )
}

private fun formatDuration(ms: Long): String {
    val totalSeconds = ms / 1000
    return "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
}

private fun formatDate(epochMs: Long): String =
    SimpleDateFormat("d MMM, HH:mm", Locale.getDefault()).format(Date(epochMs))
