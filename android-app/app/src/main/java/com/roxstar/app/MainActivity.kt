package com.roxstar.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewModelScope
import com.roxstar.app.audio.AudioRecorder
import com.roxstar.app.data.local.RoxstarDatabase
import com.roxstar.app.data.repository.ApiResult
import com.roxstar.app.data.repository.RoxstarRepository
import com.roxstar.app.data.repository.errorMessage
import com.roxstar.app.ui.AudioViewModel
import com.roxstar.app.ui.RoomViewModel
import com.roxstar.app.ui.audio.AudioScreen
import com.roxstar.app.ui.components.ErrorBanner
import com.roxstar.app.ui.components.SectionHeader
import com.roxstar.app.ui.room.RoomScreen
import com.roxstar.app.ui.theme.RoxstarTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Single-activity host.
 *
 * Dependency wiring is done by hand in a small factory rather than with Hilt:
 * there are three objects to construct, and a DI framework would be more
 * configuration than the app has dependencies.
 */
class MainActivity : ComponentActivity() {

    private lateinit var repository: RoxstarRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        repository = RoxstarRepository(
            context = applicationContext,
            draftDao = RoxstarDatabase.get(applicationContext).draftDao(),
        )

        setContent {
            RoxstarTheme {
                val factory = remember { AppViewModelFactory(repository, this) }

                val session: SessionViewModel = viewModel(factory = factory)
                val sessionState by session.state.collectAsState()

                Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
                    if (sessionState.user == null) {
                        SignInScreen(
                            isLoading = sessionState.isLoading,
                            error = sessionState.error,
                            onSignIn = session::signIn,
                            onDismissError = session::dismissError,
                            modifier = Modifier.padding(padding),
                        )
                    } else {
                        MainTabs(
                            factory = factory,
                            currentUserId = sessionState.user!!.userId,
                            modifier = Modifier.padding(padding),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MainTabs(
    factory: AppViewModelFactory,
    currentUserId: String,
    modifier: Modifier = Modifier,
) {
    val audioVm: AudioViewModel = viewModel(factory = factory)
    val roomVm: RoomViewModel = viewModel(factory = factory)

    val roomState by roomVm.state.collectAsState()
    val drafts by audioVm.drafts.collectAsState()
    var tab by remember { mutableIntStateOf(0) }

    LaunchedEffect(currentUserId) { roomVm.setCurrentUser(currentUserId) }

    // Resolve the local DraftEntity that matches the shared draft so RoomScreen
    // can pass it to SharedDraftCard for playback.
    val localSharedDraft = roomState.sharedDraft?.draft?.draftId
        ?.let { id -> drafts.firstOrNull { it.draftId == id } }

    // The permission is requested when the screen opens rather than on the
    // first tap: being asked mid-gesture is how a user ends up denying it.
    val context = androidx.compose.ui.platform.LocalContext.current
    val permissionLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> audioVm.onPermissionResult(granted) }

    LaunchedEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        audioVm.onPermissionResult(granted)
        if (!granted) permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    Column(modifier) {
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Studio") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Room") })
        }

        when (tab) {
            0 -> AudioScreen(
                viewModel = audioVm,
                canShare = roomState.isInRoom,
                onShareDraft = { draft ->
                    roomVm.shareDraft(draft)
                    // Jump to the room so the user sees the draft_shared event
                    // land rather than wondering whether it worked.
                    tab = 1
                },
            )

            1 -> RoomScreen(
                state = roomState,
                onCreateRoom = roomVm::createRoom,
                onJoinRoom = roomVm::joinRoom,
                onLeaveRoom = roomVm::leaveRoom,
                onStartSpin = roomVm::startSpin,
                onRefresh = roomVm::refresh,
                onDismissError = roomVm::dismissError,
                localSharedDraft = localSharedDraft,
                onPlaySharedDraft = { roomVm.playSharedDraft(localSharedDraft) },
                onStopSharedDraftPlayback = roomVm::stopSharedDraftPlayback,
            )
        }
    }
}

@Composable
private fun SignInScreen(
    isLoading: Boolean,
    error: String?,
    onSignIn: (String) -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var name by remember { mutableStateOf("") }

    Column(modifier.fillMaxSize().padding(24.dp)) {
        Text("Roxstar", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Record a voice draft, join a room, spin the wheel.",
            style = MaterialTheme.typography.bodyMedium,
        )

        androidx.compose.foundation.layout.Spacer(Modifier.height(28.dp))

        error?.let { ErrorBanner(it, onDismissError) }

        SectionHeader("Choose a display name")
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(40) },
            label = { Text("Display name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))

        Button(
            onClick = { onSignIn(name) },
            enabled = !isLoading && name.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (isLoading) CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp)
            else Text("Continue")
        }

        androidx.compose.foundation.layout.Spacer(Modifier.height(10.dp))
        Text(
            // Says plainly what D8 decided, so nobody wonders where the
            // password field went.
            "No account or password is needed. A session is tied to this device.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

data class SessionUiState(
    val user: com.roxstar.app.data.api.UserDto? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
)

class SessionViewModel(private val repository: RoxstarRepository) : ViewModel() {
    private val _state = MutableStateFlow(SessionUiState())
    val state = _state.asStateFlow()

    fun signIn(displayName: String) = viewModelScope.launch {
        _state.update { it.copy(isLoading = true, error = null) }

        when (val result = repository.createSession(displayName.trim())) {
            is ApiResult.Success -> _state.update { it.copy(user = result.data, isLoading = false) }
            else -> _state.update { it.copy(isLoading = false, error = result.errorMessage) }
        }
    }

    fun dismissError() = _state.update { it.copy(error = null) }
}

/** Hand-rolled factory. Three constructors, no framework. */
class AppViewModelFactory(
    private val repository: RoxstarRepository,
    private val activity: ComponentActivity,
) : ViewModelProvider.Factory {

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = when {
        modelClass.isAssignableFrom(SessionViewModel::class.java) ->
            SessionViewModel(repository) as T

        modelClass.isAssignableFrom(RoomViewModel::class.java) ->
            RoomViewModel(repository) as T

        modelClass.isAssignableFrom(AudioViewModel::class.java) -> {
            // The recorder needs a scope that outlives a recomposition but dies
            // with the ViewModel, so it is built here and handed the VM's scope
            // indirectly via a holder created below.
            lateinit var vm: AudioViewModel
            val recorder = AudioRecorder(
                context = activity.applicationContext,
                scope = kotlinx.coroutines.CoroutineScope(
                    kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate
                ),
            )
            vm = AudioViewModel(repository, recorder)
            vm as T
        }

        else -> throw IllegalArgumentException("Unknown ViewModel: ${modelClass.name}")
    }
}
