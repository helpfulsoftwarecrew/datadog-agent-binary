#!/bin/sh
# Replace the live component with a staged and checked tree, run inside the container as root. Reversible: the
# old one is parked under .backups/, outside components/, because Harper loads anything in there as a component.
set -e
V="$1"
H=/home/harperdb/harper
echo "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
	|| { echo "REFUSED: \"$V\" is not an exact version such as 8.0.0"; exit 1; }
STAGE="$H/.staging/dab-$V"
LIVE="$H/components/datadog-agent-binary"

[ -d "$STAGE" ] || { echo "REFUSED: nothing staged at $STAGE"; exit 1; }
OLD=$(grep -m1 '"version"' "$LIVE/package.json" | sed 's/.*: *"//; s/".*//')
PARK="$H/.backups/datadog-agent-binary-$OLD-replaced-by-$V"
rm -rf "$PARK"
mv "$LIVE" "$PARK"
mv "$STAGE" "$LIVE"
echo "  live tree is now $V; $OLD parked at $PARK"
