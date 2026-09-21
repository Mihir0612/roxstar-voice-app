package com.roxstar.app.ui.room

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import com.roxstar.app.data.api.SpinParticipantDto
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

private val SliceColors = listOf(
    Color(0xFFE57373),
    Color(0xFF64B5F6),
    Color(0xFF81C784),
    Color(0xFFFFB74D),
    Color(0xFFBA68C8),
    Color(0xFF4DD0E1),
    Color(0xFFFF8A65),
    Color(0xFFA1887F),
    Color(0xFF90A4AE),
    Color(0xFFF06292),
)

/**
 * Interactive Spin Wheel Canvas rendering slices for room participants.
 *
 * - When [isRunning] is true, rotates continuously.
 * - Eliminated participants are rendered with decreased opacity (alpha 0.20f) and dimmed text.
 * - Active remaining participants retain full opacity and vibrant colors.
 */
@Composable
fun SpinWheelCanvas(
    participants: List<SpinParticipantDto>,
    isRunning: Boolean,
    winnerUserId: String? = null,
    modifier: Modifier = Modifier,
) {
    if (participants.isEmpty()) return

    val infiniteTransition = rememberInfiniteTransition(label = "SpinWheelRotation")
    val rotationAngle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 3000, easing = LinearEasing),
        ),
        label = "rotationAngle",
    )

    val currentRotation = if (isRunning) rotationAngle else 0f

    Box(
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .padding(16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.fillMaxWidth().aspectRatio(1f)) {
            val center = Offset(size.width / 2f, size.height / 2f)
            val radius = (size.minDimension / 2f) * 0.88f
            val sweepAngle = 360f / participants.size

            rotate(degrees = currentRotation, pivot = center) {
                participants.forEachIndexed { index, participant ->
                    val startAngle = index * sweepAngle
                    val isEliminated = participant.status == "ELIMINATED" || participant.status == "LEFT"
                    val isWinner = winnerUserId != null && participant.userId == winnerUserId

                    val baseColor = SliceColors[index % SliceColors.size]
                    val sliceAlpha = if (isEliminated) 0.20f else if (isWinner) 1.0f else 0.85f

                    // Draw Slice arc
                    drawArc(
                        color = baseColor.copy(alpha = sliceAlpha),
                        startAngle = startAngle,
                        sweepAngle = sweepAngle,
                        useCenter = true,
                        topLeft = Offset(center.x - radius, center.y - radius),
                        size = Size(radius * 2, radius * 2),
                    )

                    // Draw border line between slices
                    val edgeAngleRad = (startAngle * PI / 180f).toFloat()
                    val edgeX = center.x + radius * cos(edgeAngleRad)
                    val edgeY = center.y + radius * sin(edgeAngleRad)
                    drawLine(
                        color = Color.White.copy(alpha = if (isEliminated) 0.3f else 0.8f),
                        start = center,
                        end = Offset(edgeX, edgeY),
                        strokeWidth = 2.dp.toPx(),
                    )

                    // Draw Participant Label inside slice
                    val midAngleRad = ((startAngle + sweepAngle / 2f) * PI / 180f).toFloat()
                    val textRadius = radius * 0.62f
                    val textX = center.x + textRadius * cos(midAngleRad)
                    val textY = center.y + textRadius * sin(midAngleRad)

                    val paint = android.graphics.Paint().apply {
                        color = if (isEliminated) android.graphics.Color.GRAY else android.graphics.Color.WHITE
                        textSize = 28f
                        textAlign = android.graphics.Paint.Align.CENTER
                        isAntiAlias = true
                        isFakeBoldText = !isEliminated
                        alpha = if (isEliminated) 100 else 255
                    }

                    drawContext.canvas.nativeCanvas.drawText(
                        participant.displayName.take(10) + (if (isEliminated) " ✖" else ""),
                        textX,
                        textY + 10f,
                        paint,
                    )
                }

                // Outer boundary circle
                drawCircle(
                    color = Color.White.copy(alpha = 0.9f),
                    radius = radius,
                    center = center,
                    style = Stroke(width = 4.dp.toPx()),
                )
            }

            // Central hub pin
            drawCircle(
                color = Color.White,
                radius = radius * 0.15f,
                center = center,
            )
            drawCircle(
                color = Color(0xFF3700B3),
                radius = radius * 0.10f,
                center = center,
            )

            // Pointer arrow at top center
            val pointerPath = Path().apply {
                moveTo(center.x, center.y - radius - 16.dp.toPx())
                lineTo(center.x - 14.dp.toPx(), center.y - radius + 10.dp.toPx())
                lineTo(center.x + 14.dp.toPx(), center.y - radius + 10.dp.toPx())
                close()
            }
            drawPath(pointerPath, color = Color(0xFFFF1744))
        }
    }
}
