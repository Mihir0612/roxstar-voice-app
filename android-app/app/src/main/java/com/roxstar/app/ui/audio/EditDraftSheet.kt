package com.roxstar.app.ui.audio

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.roxstar.app.ui.AudioUiState
import com.roxstar.app.ui.AudioViewModel

/**
 * Full-screen dialog that lets the user apply Echo, Reverse Echo, and Pitch
 * effects to an existing draft and save the result as a new named draft.
 *
 * The original draft is never modified — all processing writes to a temp file.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditDraftSheet(
    ui: AudioUiState,
    viewModel: AudioViewModel,
) {
    val draft = ui.editingDraft ?: return

    Dialog(
        onDismissRequest = { if (!ui.editProcessing) viewModel.closeEditDraft() },
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        androidx.compose.material3.Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
        ) {
            Column(modifier = Modifier.fillMaxSize()) {

                // ── App bar ──────────────────────────────────────────────────
                TopAppBar(
                    title = {
                        Column {
                            Text("Edit Draft", style = MaterialTheme.typography.titleMedium)
                            Text(
                                draft.name,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(
                            onClick = viewModel::closeEditDraft,
                            enabled = !ui.editProcessing,
                        ) {
                            Icon(Icons.Default.Close, contentDescription = "Cancel edit")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                )

                // ── Controls ─────────────────────────────────────────────────
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {

                    // Original info card
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    ) {
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            Text(
                                "Original: ${formatDuration(draft.durationMs)} · ${draft.effect}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(2.dp))
                            Text(
                                "Adjusting effects below creates a new draft. The original stays untouched.",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }

                    // ── Echo toggle ──────────────────────────────────────────
                    EffectRow(
                        label = "Echo",
                        description = "Adds a repeating delay behind the voice",
                        checked = ui.editEchoEnabled,
                        onCheckedChange = viewModel::setEditEcho,
                        enabled = !ui.editProcessing,
                    )

                    // ── Reverse Echo toggle ──────────────────────────────────
                    EffectRow(
                        label = "Reverse Echo",
                        description = "Swell effect: echo applied to the reversed audio",
                        checked = ui.editReverseEchoEnabled,
                        onCheckedChange = viewModel::setEditReverseEcho,
                        enabled = !ui.editProcessing,
                    )

                    // ── Pitch shift slider ───────────────────────────────────
                    PitchSliderRow(
                        semitones = ui.editPitchSemitones,
                        onSemitonesChange = viewModel::setEditPitch,
                        enabled = !ui.editProcessing,
                    )
                }

                // ── Bottom action bar ────────────────────────────────────────
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.fillMaxWidth().padding(16.dp)) {

                        // Preview button
                        if (ui.editProcessing) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                                Text("Processing…", style = MaterialTheme.typography.bodySmall)
                            }
                        } else {
                            OutlinedButton(
                                onClick = { if (ui.editPreviewPlaying) viewModel.stopEditPreview() else viewModel.previewEdit() },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(
                                    imageVector = if (ui.editPreviewPlaying) Icons.Default.Stop else Icons.Default.PlayArrow,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.size(6.dp))
                                Text(if (ui.editPreviewPlaying) "Stop Preview" else "▶  Preview with Effects")
                            }

                            Spacer(Modifier.height(8.dp))

                            // Done button
                            Button(
                                onClick = viewModel::finishEdit,
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.primary,
                                ),
                            ) {
                                Icon(Icons.Default.Done, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(6.dp))
                                Text("Done — Save as New Draft")
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Name dialog shown after Done ─────────────────────────────────────────
    ui.pendingEditSave?.let {
        SaveEditedDraftDialog(
            onConfirm = viewModel::confirmEditSave,
            onDiscard = viewModel::discardEditSave,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-composables
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun EffectRow(
    label: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean,
) {
    Card {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(description, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(
                checked = checked,
                onCheckedChange = onCheckedChange,
                enabled = enabled,
            )
        }
    }
}

@Composable
private fun PitchSliderRow(
    semitones: Float,
    onSemitonesChange: (Float) -> Unit,
    enabled: Boolean,
) {
    Card {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Pitch Shift",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    when {
                        semitones > 0 -> "+${semitones.toInt()} st"
                        semitones < 0 -> "${semitones.toInt()} st"
                        else -> "No shift"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = if (semitones != 0f) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "Slide left to lower pitch, right to raise it",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            Slider(
                value = semitones,
                onValueChange = { onSemitonesChange(it.toInt().toFloat()) },
                valueRange = -12f..12f,
                steps = 23,   // 25 positions − 2 ends = 23 interior steps
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("−12", style = MaterialTheme.typography.labelSmall)
                Text("0", style = MaterialTheme.typography.labelSmall)
                Text("+12", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun SaveEditedDraftDialog(
    onConfirm: (String) -> Unit,
    onDiscard: () -> Unit,
) {
    var name by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDiscard,
        title = { Text("Save Edited Draft") },
        text = {
            Column {
                Text("Enter a name for your edited draft.")
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Draft name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("e.g. My Echo Mix") },
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(name.ifBlank { "Edited take" }) },
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDiscard) { Text("Back to edit") }
        },
    )
}

private fun formatDuration(ms: Long): String {
    val totalSeconds = ms / 1000
    return "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
}
