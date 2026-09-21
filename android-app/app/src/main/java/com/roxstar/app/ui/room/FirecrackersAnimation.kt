package com.roxstar.app.ui.room

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

private data class FirecrackerParticle(
    var x: Float,
    var y: Float,
    var vx: Float,
    var vy: Float,
    val color: Color,
    val radius: Float,
    var alpha: Float = 1.0f,
    val decay: Float = 0.015f + Random.nextFloat() * 0.02f,
)

private val BrightColors = listOf(
    Color(0xFFFF1744), // Red
    Color(0xFFFFEA00), // Yellow
    Color(0xFF00E676), // Green
    Color(0xFF2979FF), // Blue
    Color(0xFFD500F9), // Purple
    Color(0xFFFF9100), // Orange
    Color(0xFF00E5FF), // Cyan
)

/**
 * Animated Canvas overlay rendering dynamic firecrackers, fireworks bursts,
 * and sparkle particles to celebrate the last remaining winner!
 */
@Composable
fun FirecrackersAnimation(
    modifier: Modifier = Modifier,
) {
    val particles = remember { mutableStateListOf<FirecrackerParticle>() }

    LaunchedEffect(Unit) {
        // Spawn initial fireworks / firecrackers bursts
        repeat(6) { burstIdx ->
            val originX = 0.2f + Random.nextFloat() * 0.6f
            val originY = 0.2f + Random.nextFloat() * 0.5f

            repeat(40) {
                val angle = Random.nextFloat() * 2f * Math.PI.toFloat()
                val speed = 3f + Random.nextFloat() * 12f
                val color = BrightColors.random()

                particles.add(
                    FirecrackerParticle(
                        x = originX,
                        y = originY,
                        vx = cos(angle) * speed,
                        vy = sin(angle) * speed,
                        color = color,
                        radius = 4f + Random.nextFloat() * 6f,
                    )
                )
            }
        }

        // Animation loop
        while (true) {
            delay(16) // ~60 FPS

            // Randomly trigger secondary firecracker explosions
            if (Random.nextFloat() < 0.15f && particles.size < 250) {
                val originX = 0.1f + Random.nextFloat() * 0.8f
                val originY = 0.1f + Random.nextFloat() * 0.6f
                val color = BrightColors.random()

                repeat(30) {
                    val angle = Random.nextFloat() * 2f * Math.PI.toFloat()
                    val speed = 2f + Random.nextFloat() * 10f
                    particles.add(
                        FirecrackerParticle(
                            x = originX,
                            y = originY,
                            vx = cos(angle) * speed,
                            vy = sin(angle) * speed,
                            color = color,
                            radius = 3f + Random.nextFloat() * 5f,
                        )
                    )
                }
            }

            // Update particles
            val iterator = particles.iterator()
            while (iterator.hasNext()) {
                val p = iterator.next()
                p.x += p.vx / 400f
                p.y += p.vy / 400f + 0.002f // gravity drift
                p.alpha -= p.decay

                if (p.alpha <= 0f) {
                    iterator.remove()
                }
            }
        }
    }

    Canvas(modifier = modifier.fillMaxSize()) {
        particles.forEach { p ->
            val px = p.x * size.width
            val py = p.y * size.height

            drawCircle(
                color = p.color.copy(alpha = p.alpha.coerceIn(0f, 1f)),
                radius = p.radius.dp.toPx(),
                center = Offset(px, py),
            )

            // Sparkle ring around bright particles
            if (p.alpha > 0.5f) {
                drawCircle(
                    color = Color.White.copy(alpha = (p.alpha * 0.6f).coerceIn(0f, 1f)),
                    radius = (p.radius * 1.6f).dp.toPx(),
                    center = Offset(px, py),
                    style = Stroke(width = 1.dp.toPx()),
                )
            }
        }
    }
}
