package com.roxstar.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val Magenta = Color(0xFFE5197F)
private val DeepInk = Color(0xFF12101A)
private val Slate = Color(0xFF1E1B2A)
private val Mint = Color(0xFF2ED3A6)
private val Amber = Color(0xFFFFB020)

private val DarkColors = darkColorScheme(
    primary = Magenta,
    onPrimary = Color.White,
    secondary = Mint,
    onSecondary = DeepInk,
    tertiary = Amber,
    background = DeepInk,
    onBackground = Color(0xFFEDEAF5),
    surface = Slate,
    onSurface = Color(0xFFEDEAF5),
    surfaceVariant = Color(0xFF2A2637),
    onSurfaceVariant = Color(0xFFB8B2C9),
    error = Color(0xFFFF6B6B),
)

private val LightColors = lightColorScheme(
    primary = Magenta,
    onPrimary = Color.White,
    secondary = Color(0xFF12A883),
    tertiary = Color(0xFFB37400),
    background = Color(0xFFFBF9FF),
    surface = Color.White,
    surfaceVariant = Color(0xFFF0EDF7),
    error = Color(0xFFC4162B),
)

private val AppTypography = Typography(
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 26.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 15.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
    ),
)

@Composable
fun RoxstarTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = AppTypography,
        content = content,
    )
}
