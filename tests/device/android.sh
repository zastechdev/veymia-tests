#!/usr/bin/env bash
# Runs on an Android test machine (GitHub or CircleCI): uses or starts one emulator, then for every game installs the real APK
# and plays the game.  Usage: android.sh veyforge veyhold ...
set -uo pipefail
games="${*:-veyforge}"; res="$(pwd)/device-results"; mkdir -p "$res"
fail() { echo "FAIL: $*"; adb logcat -d > "$res/android-logcat.txt" 2>/dev/null; cp emulator.log "$res/" 2>/dev/null; exit 1; }

ready() {  # wait until the emulator answers and has finished booting
  for i in $(seq 1 60); do
    adb reconnect offline >/dev/null 2>&1
    if [ "$(adb get-state 2>/dev/null)" = "device" ] && [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then return 0; fi
    sleep 5
  done
  return 1
}

if [ -z "${EMULATOR_RUNNING:-}" ]; then   # on GitHub the emulator action starts it before this script
  echo "== start emulator"
  sdkmanager "system-images;android-34;default;x86_64" >/dev/null
  echo no | avdmanager create avd -n test -k "system-images;android-34;default;x86_64" -d pixel_6 >/dev/null
  (emulator -avd test -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim -no-metrics -cores 4 -memory 4096 > emulator.log 2>&1 &)
fi
timeout 300 adb wait-for-device || fail "emulator did not start"
ready || fail "emulator did not finish booting"
sleep 20; ready || fail "emulator went offline after boot"
adb shell settings put secure immersive_mode_confirmations confirmed
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1
for k in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global $k 0; done
adb shell getprop ro.build.version.release | sed 's/^/Android /'

install() { for i in 1 2 3; do ready && adb install -r "$1" && return 0; echo "install retry $i"; sleep 10; done; return 1; }
launch() {  # start the app and wait until its process is up
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1
  adb shell am start -W -n "$pkg/.MainActivity" >/dev/null 2>&1
  for i in $(seq 1 30); do p=$(adb shell pidof "$pkg" | tr -d '\r'); [ -n "$p" ] && { sleep 15; return 0; }; sleep 2; done
  return 1
}

test_game() {
  game="$1"; pkg="com.veymia.$game"
  echo; echo "############ $game"
  echo "== release APK (the file people download)"
  install "out/downloads/$game.apk" || { echo "FAIL ($game): release APK did not install"; return 1; }
  adb logcat -c; launch || { echo "FAIL ($game): release app did not start"; return 1; }
  adb exec-out screencap -p > "$res/android-$game-release-open.png"
  pid=$(adb shell pidof "$pkg" | tr -d '\r')
  adb logcat -d > "$res/android-$game-release-logcat.txt"
  [ -n "$pid" ] || { echo "FAIL ($game): release app is not running after launch"; return 1; }
  grep -q "FATAL EXCEPTION" "$res/android-$game-release-logcat.txt" && { echo "FAIL ($game): release app crashed"; return 1; }
  echo "release app running (pid $pid)"
  adb uninstall "$pkg" >/dev/null

  echo "== play the game (test build: same app, WebView inspectable)"
  install "out-test/$game-test.apk" || { echo "FAIL ($game): test APK did not install"; return 1; }
  launch || { echo "FAIL ($game): test app did not start"; return 1; }
  pid=$(adb shell pidof "$pkg" | tr -d '\r'); [ -n "$pid" ] || { echo "FAIL ($game): test app is not running"; return 1; }
  sock=""
  for i in $(seq 1 30); do sock=$(adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_$pid" | head -1); [ -n "$sock" ] && break; sleep 2; done
  [ -n "$sock" ] || { adb shell cat /proc/net/unix | grep -i devtools; { echo "FAIL ($game): WebView debugging socket not found"; return 1; }; }
  adb forward tcp:9222 "localabstract:$sock"
  (cd tests/device && npm ci --no-audit --no-fund >/dev/null && FPS_MIN=8 node "smoke-$game.mjs" "lite:http://127.0.0.1:9222" "$res" android); code=$?
  adb exec-out screencap -p > "$res/android-$game-end.png"
  adb logcat -d > "$res/android-$game-logcat.txt"
  grep -q "FATAL EXCEPTION" "$res/android-$game-logcat.txt" && { echo "FAIL ($game): app crashed during play"; return 1; }
  adb uninstall "$pkg" >/dev/null 2>&1
  return $code
}

status=0
for game in $games; do test_game "$game" || status=1; done
exit $status
