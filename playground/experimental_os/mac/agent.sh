#!/bin/sh
# agent.sh: ermineOS always running. A launchd agent for this person
# (~/Library/LaunchAgents/party.chee.ermineos.plist) starts the app at login
# and starts it again whenever it ends: quit, power off, or a crash, after a
# few seconds. Only stopping the agent stops it for good.
#
#   sh agent.sh start [args...]   install the agent and start it (args go to ermineOS, e.g. --fullscreen --take-over)
#   sh agent.sh stop              stop it and remove the agent
#   sh agent.sh status            what launchd says of it
#
# It runs mac/build/ermineOS.app, which sh app.sh builds and bundles again,
# so each start is the newest one. Its output: ~/.ermine/agent.log.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
label=party.chee.ermineos
# the agent's plist: in ~/Library/LaunchAgents, which launchd reads at login;
# where that cannot be written (an installer made it root's), in ~/.ermine,
# loaded now but not at the next login
plist="$HOME/Library/LaunchAgents/$label.plist"
if [ -e "$HOME/Library/LaunchAgents" ] && [ ! -w "$HOME/Library/LaunchAgents" ]; then
  plist="$HOME/.ermine/$label.plist"
fi
domain="gui/$(id -u)"

# the newest app (app.sh bundles it): launchd starts what is there at each start;
# ERMINE_APP for another (a signed identity's grants follow the app, not where it is)
app="${ERMINE_APP:-$here/build/ermineOS.app}"

case "${1:-}" in
start)
  shift
  if [ ! -d "$app" ]; then
    echo "no ermineOS.app: sh $here/app.sh first" >&2
    exit 1
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.ermine"
  args=""
  for a in "$@"; do args="$args		<string>$a</string>
"; done
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$app/Contents/MacOS/ermineOS</string>
$args	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ProcessType</key><string>Interactive</string>
	<key>LimitLoadToSessionType</key><string>Aqua</string>
	<key>StandardOutPath</key><string>$HOME/.ermine/agent.log</string>
	<key>StandardErrorPath</key><string>$HOME/.ermine/agent.log</string>
</dict>
</plist>
EOF
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist"
  echo "started $label: $app, kept running (sh agent.sh stop to end it)"
  case "$plist" in "$HOME/.ermine/"*)
    echo "~/Library/LaunchAgents is not yours to write, so the agent is in $plist: running now, but not started at your next login." >&2
    echo "to have it at login: sudo chown $(id -un) ~/Library/LaunchAgents, then sh agent.sh start again" >&2
  esac
  ;;
stop)
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist" "$HOME/.ermine/$label.plist" 2>/dev/null || true
  echo "stopped $label, and removed $plist"
  ;;
status)
  launchctl print "$domain/$label" 2>/dev/null | grep -E "state =|pid =|last exit|runs =" || echo "$label: not loaded"
  ;;
*)
  echo "usage: sh agent.sh start [args...] | stop | status" >&2
  exit 2
  ;;
esac
