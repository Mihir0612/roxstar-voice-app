# Running and testing the app

How to get Roxstar onto an Android device and exercise the full flow, including
the spin — which needs three players when you probably have one phone.

---

## The short version

```bash
# 1. Backend
docker compose up -d

# 2. Build the APK, pointed at your machine's LAN IP
cd android-app
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"
./gradlew assembleDebug -PROXSTAR_API_BASE_URL_DEBUG=http://<YOUR-LAN-IP>:8080

# 3. Install it
"$HOME/AppData/Local/Android/Sdk/platform-tools/adb.exe" install -r \
  app/build/outputs/apk/debug/app-debug.apk

# 4. In the app: enter a name, create a room, note the 6-character code.
#    Then, to reach 3 players:
cd ../tests && npm ci
node e2e/join-bots.mjs <ROOM_CODE> 2 http://<YOUR-LAN-IP>:8080

# 5. Tap "Start spin" in the app.
```

On this machine the LAN IP is **192.168.1.24** and the APK is already built
against it.

---

## 1. Start the backend

```bash
docker compose up -d
curl http://localhost:8080/health
```

Expect `{"status":"ok",...}`. If not:

```bash
docker compose logs backend --tail 30
```

---

## 2. Pick how the phone reaches your machine

This is where most first attempts fail, so it is worth getting right up front.

### Physical phone (recommended — you need a real microphone for Oboe)

The phone must be on **the same wifi** as your machine, and the APK must be
built against your machine's LAN IP.

Find it:

```bash
# Windows
ipconfig | grep -A4 "Wireless LAN" | grep IPv4

# or
powershell -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*'} | Select IPAddress"
```

Ignore `172.x` (Docker) and `192.168.56.x` (VirtualBox). You want the one
matching your router's range, usually `192.168.1.x` or `192.168.0.x`.

Check the phone can actually reach it — open `http://<LAN-IP>:8080/health` in
the phone's browser **before** installing anything. If that fails, the app will
fail too, and the browser tells you why faster.

If it does not load, it is almost always Windows Firewall. Allow it once:

```powershell
New-NetFirewallRule -DisplayName "Roxstar backend 8080" -Direction Inbound `
  -LocalPort 8080 -Protocol TCP -Action Allow
```

### Emulator

An emulator reaches the host at the special address `10.0.2.2`, which is the
default in `gradle.properties`, so `./gradlew assembleDebug` needs no flags.

You have no AVD yet. Create one in **Android Studio → Device Manager → Create
device**; the `android-35 google_apis x86_64` image is already downloaded.

> The emulator's microphone is whatever your PC's microphone is, and audio
> through an emulator is unreliable. Rooms and the spin work fine there; for
> judging the Oboe path, use a real phone.

---

## 3. Build and install

```bash
cd android-app
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"

# physical phone
./gradlew assembleDebug -PROXSTAR_API_BASE_URL_DEBUG=http://192.168.1.24:8080

# emulator
./gradlew assembleDebug
```

Put the phone in developer mode (tap **Build number** seven times in
Settings → About phone), enable **USB debugging**, plug it in and accept the
prompt on the phone. Then:

```bash
ADB="$HOME/AppData/Local/Android/Sdk/platform-tools/adb.exe"
"$ADB" devices              # your phone should be listed as "device"
"$ADB" install -r android-app/app/build/outputs/apk/debug/app-debug.apk
```

`-r` reinstalls over an existing copy, keeping its data.

No cable? Copy `app-debug.apk` to the phone and open it — you will have to allow
installing from that source once.

Grant the **microphone** permission when the app asks. Denying it is a
supported path (the app explains and offers a retry), but you cannot record.

---

## 4. Testing the audio side

No backend needed for any of this — recording is entirely local.

1. **Studio** tab
2. Pick an effect: **Echo**, **Reverb (echo-based)** or **Pitch Shift**
3. **Start recording** — the bar underneath is the live peak level from the
   Oboe callback. If it does not move, the microphone is not delivering audio.
4. Say something for a few seconds, **Stop & save**, give it a name
5. It appears in **Drafts** with duration, effect and timestamp
6. **▶** plays it back. The effect should be clearly audible — echo repeats
   about every 250 ms; pitch shift is +5 semitones.
7. **🗑** deletes it, file and all

Worth trying deliberately, because all of these are handled:

- Record, then **Cancel** — nothing is saved, no stray file is left behind
- Start and stop several times in a row — the Oboe stream is closed and
  reopened cleanly each time
- Start recording, then take a phone call or unplug a headset — the stream is
  disconnected, and whatever was captured up to that point is **kept** rather
  than discarded

---

## 5. Testing rooms and the spin

### The three-player problem

A spin needs **at least 3 eligible users**, and that rule is enforced by the
server. With one phone you would be stuck at one player.

`tests/e2e/join-bots.mjs` solves it. The bots are ordinary clients: they
authenticate, join by code, open real WebSockets and hold their seats. They do
not decide anything — they cannot, the server is authoritative — they just
occupy seats and print the event stream as it arrives.

### Walkthrough

1. In the app: **Room** tab → name it → **Create room**
2. Note the **6-character code** under the room name, e.g. `6W9EB6`
3. On your machine:

```bash
cd tests
npm ci                       # first time only
node e2e/join-bots.mjs 6W9EB6 2 http://192.168.1.24:8080
```

```
Joining 2 bot(s) to room 6W9EB6 on http://192.168.1.24:8080

  connected: Bot Ada
[11:59:03 pm] + Bot Linus joined (3 in room)
  connected: Bot Linus

2 bot(s) in the room. With you that is 3 players.
Enough to start a spin — tap "Start spin" in the app.
```

Both bots appear in the app's participant list within a second — that is
`user_joined` arriving over the WebSocket.

4. **Start spin** in the app. The terminal narrates what the server broadcasts:

```
[11:59:41 pm] ▶ SPIN STARTED with 3 players: Bot Ada, Bot Linus, Phone User
[11:59:47 pm]   ✗ Bot Ada out (#1, SPIN) — 2 left
[11:59:52 pm]   ✗ Phone User out (#2, SPIN) — 1 left
[11:59:52 pm] 🏆 WINNER: Bot Linus
```

The app shows the same thing, from the same events. One elimination every five
seconds; the winner is announced in the same tick as the final elimination, so
there is no dead five seconds at the end.

Add more bots for a longer spin: `node e2e/join-bots.mjs 6W9EB6 5`.

### Sharing a draft

With the bots connected, go to **Studio**, tap **⤴** on a draft. The app jumps
to the Room tab and the shared draft appears; the bot terminal prints:

```
[00:03:11] ♪ draft shared: "Take 1" 7200ms, effect=ECHO
```

Only the metadata travels. The audio stays on the phone — that is deliberate
(see D10), and the end-to-end suite asserts no event payload ever contains
audio data.

---

## 6. Edge cases worth demonstrating

These are the interesting ones, and each is quick.

| Try this | What should happen |
|---|---|
| **Tap Start spin twice quickly** | Second attempt is refused: *"A spin is already running."* |
| **Start with only 2 players** | Refused with the real numbers: *"Need at least 3 players (currently 2)."* The button is disabled and says why. |
| **Leave the room mid-spin** | You are forfeited, not merely removed. The app shows *"(forfeited)"* next to your name, and the bots print `reason=LEFT`. You cannot win a spin you walked out of. |
| **Turn wifi off mid-spin, then back on** | You show as *reconnecting* for up to 15 seconds and keep your seat. On reconnect the app catches up on everything it missed in one `room_state`. Stay off longer than 15 s and you are forfeited. |
| **Ctrl+C the bots mid-spin** | Same grace period, then they forfeit. With one player left, the winner is declared immediately. |
| **`docker compose restart backend` mid-spin** | The spin **resumes**. The deadline lives in the database, so a fresh process picks it up on its first tick. The app reconnects and re-syncs. |
| **Start a spin as a non-owner** | Only the owner sees an enabled button; a bot attempting it gets 403. |

---

## 7. When something does not work

**App shows a network error immediately**
The endpoint is wrong or unreachable. Check what was baked in:

```bash
"$HOME/AppData/Local/Android/Sdk/platform-tools/adb.exe" logcat -s RoomSocket:* okhttp:*
```

Then open `http://<LAN-IP>:8080/health` in the phone's browser. If the browser
cannot load it, neither can the app — that is firewall or wrong IP, not the app.

**Participants list is empty and the pill says "Offline"**
REST worked but the WebSocket did not. Usually a proxy or VPN on the phone.
Turn off any VPN and retry.

**"Start spin" stays disabled**
Read the line under it — it states the reason: too few players, not the owner,
or a spin already running.

**Recording does nothing, level bar flat**
Microphone permission was denied. Settings → Apps → Roxstar → Permissions.

**Bots fail with "join failed"**
The room code is wrong or the room is gone. Codes use the alphabet
`23456789ABCDEFGHJKMNPQRSTVWXYZ` — no I, L, O, U, 0 or 1, precisely so they are
not misread. Create a fresh room and use the new code.

**`adb devices` shows nothing**
USB debugging is off, the cable is charge-only, or you have not accepted the
authorisation prompt on the phone.

---

## 8. Watching the backend while you test

```bash
# live logs
docker compose logs -f backend

# what the database thinks happened
docker exec roxstar-postgres psql -U roxstar -d roxstar -c \
  "SELECT event_type, payload, created_at FROM spin_events ORDER BY seq DESC LIMIT 10;"
```

That last query is the audit trail. Every event a client saw was written there
first — the broadcast happens only after the transaction commits.
