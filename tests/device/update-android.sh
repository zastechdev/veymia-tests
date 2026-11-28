#!/usr/bin/env bash
# Update test on a real Android emulator: the old app finds a newer version on a local server, downloads it
# quietly, and uses it the next time it opens; it must then stay on the new version (no rollback).
# Expects upd/<game>-old.apk, upd/server/ and upd/info.txt ("game old new").
set -uo pipefail
read -r game old new < upd/info.txt; pkg="com.veymia.$game"; res="$(pwd)/device-results"; mkdir -p "$res"
ready() { for i in $(seq 1 60); do adb reconnect offline >/dev/null 2>&1; if [ "$(adb get-state 2>/dev/null)" = "device" ] && [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then return 0; fi; sleep 5; done; return 1; }
timeout 300 adb wait-for-device; ready || { echo "FAIL emulator"; exit 1; }; sleep 15
(cd upd/server && python3 -m http.server 8765 > "$res/update-server.log" 2>&1 &)
sleep 2; curl -s "http://127.0.0.1:8765/updates/$game/android.json" | head -c 300; echo
(cd tests/device && npm ci --no-audit --no-fund >/dev/null)
version() {
  pid=$(adb shell pidof "$pkg" | tr -d '\r'); sock=""
  for i in $(seq 1 30); do sock=$(adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_$pid" | head -1); [ -n "$sock" ] && break; sleep 2; done
  [ -n "$sock" ] || { echo "version=none"; return; }
  adb forward --remove-all; adb forward tcp:9222 "localabstract:$sock" >/dev/null
  (cd tests/device && node check-version.mjs lite:http://127.0.0.1:9222)
}
start() { adb shell am start -W -n "$pkg/.MainActivity" >/dev/null 2>&1; sleep 12; }
adb install -r "upd/$game-old.apk" || { echo "FAIL install"; exit 1; }
start; v1=$(version); echo "first start: $v1"; sleep 25   # the app checks and downloads in the background
adb exec-out screencap -p > "$res/update-android-1.png"
adb shell am force-stop "$pkg"; sleep 2
start; v2=$(version); echo "second start: $v2"
sleep 25; adb shell am force-stop "$pkg"; sleep 2
start; v3=$(version); echo "third start: $v3"
adb exec-out screencap -p > "$res/update-android-2.png"
adb logcat -d > "$res/update-android-logcat.txt"
grep -c "updates/$game" "$res/update-server.log" | sed 's/^/server requests: /'
ok=0
[[ "$v1" == *"version=$old"* ]] && echo "PASS starts at $old" || { echo "FAIL first start is not $old"; ok=1; }
[[ "$v2" == *"version=$new"* ]] && echo "PASS updated to $new on the next start" || { echo "FAIL not updated: $v2"; ok=1; }
[[ "$v3" == *"version=$new"* ]] && echo "PASS stays on $new (no rollback)" || { echo "FAIL rolled back: $v3"; ok=1; }
exit $ok
