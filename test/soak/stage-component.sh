#!/bin/sh
# Stage one published version the way Harper installs a component, outside components/ so Harper never scans a
# half-built tree. Run it inside the container as root, which the ownership changes after the installs need.
set -e
V="$1"
T="$2"   # platform label, e.g. linux-arm64
H=/home/harperdb/harper

# An exact version, never a dist-tag: a tag stages whatever it names on the day, not the version under test.
echo "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
	|| { echo "REFUSED: \"$V\" is not an exact version such as 8.0.0"; exit 1; }
case "$T" in
	linux-x86_64|linux-arm64) ;;
	*) echo "REFUSED: \"$T\" is not linux-x86_64 or linux-arm64"; exit 1 ;;
esac
STAGE="$H/.staging/dab-$V"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cd "$STAGE"
npm pack "@helpfulsoftwarecrew/datadog-agent-binary@$V" --loglevel=error >/dev/null
tar xzf ./*.tgz --strip-components=1
rm -f ./*.tgz

# The root package and its platform binaries. `prepare` runs here, which is why it must tolerate a missing husky.
npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null

# The probe is deliberately not an optionalDependency: listed as one it would install on every matching host,
# and its eBPF objects are 42 MB that most hosts cannot load. An operator who wants runtime security asks for it.
npm install "@helpfulsoftwarecrew/datadog-agent-binary-probe-$T@$V" \
	--omit=dev --no-audit --no-fund --no-save --loglevel=error >/dev/null

# npm wrote this tree as root; Harper installs a component as the user it runs as, who owns the Harper root.
chown -R "$(stat -c %u:%g "$H")" "$STAGE"
# system-probe refuses an eBPF object that root:root does not own, whoever Harper runs as.
chown -R 0:0 "node_modules/@helpfulsoftwarecrew/datadog-agent-binary-probe-$T"

# Refuse a staged tree that is missing anything the live one needs, before it can replace the live one.
for want in package.json resources.js runtime/component.js runtime/verify.js conf.d config.yaml; do
	[ -e "$want" ] || { echo "REFUSED: staged tree has no $want"; exit 1; }
done
for want in harper-process-guard harper-binary-kit "datadog-agent-binary-$T" "datadog-agent-binary-probe-$T"; do
	[ -d "node_modules/@helpfulsoftwarecrew/$want" ] || { echo "REFUSED: staged tree has no $want"; exit 1; }
done
[ -d "node_modules/@helpfulsoftwarecrew/datadog-agent-binary-probe-$T/share/system-probe" ] \
	|| { echo "REFUSED: the probe package carries no eBPF objects"; exit 1; }

version() { node -p "require('./$1/package.json').version"; }
[ "$(version .)" = "$V" ] || { echo "REFUSED: the component staged as $(version .), not $V"; exit 1; }
for pkg in "datadog-agent-binary-$T" "datadog-agent-binary-probe-$T"; do
	[ "$(version "node_modules/@helpfulsoftwarecrew/$pkg")" = "$V" ] \
		|| { echo "REFUSED: $pkg staged as $(version "node_modules/@helpfulsoftwarecrew/$pkg"), not $V"; exit 1; }
done
for dep in harper-process-guard harper-binary-kit; do
	pinned=$(node -p "require('./package.json').dependencies['@helpfulsoftwarecrew/$dep']")
	[ "$(version "node_modules/@helpfulsoftwarecrew/$dep")" = "$pinned" ] \
		|| { echo "REFUSED: $dep staged as $(version "node_modules/@helpfulsoftwarecrew/$dep"), the component pins $pinned"; exit 1; }
done

echo "staged $V at $STAGE"
echo "  component: $(grep -m1 '"version"' package.json | tr -d ' \t,') owned by $(stat -c '%U:%G' .)"
echo "  guard:     $(grep -m1 '"version"' node_modules/@helpfulsoftwarecrew/harper-process-guard/package.json | tr -d ' \t,')"
echo "  kit:       $(grep -m1 '"version"' node_modules/@helpfulsoftwarecrew/harper-binary-kit/package.json | tr -d ' \t,')"
echo "  probe:     $(grep -m1 '"version"' node_modules/@helpfulsoftwarecrew/datadog-agent-binary-probe-$T/package.json | tr -d ' \t,') owned by $(stat -c '%U:%G' node_modules/@helpfulsoftwarecrew/datadog-agent-binary-probe-$T)"
echo "  binaries:  $(ls node_modules/@helpfulsoftwarecrew/datadog-agent-binary-$T/bin node_modules/@helpfulsoftwarecrew/datadog-agent-binary-probe-$T/bin | tr '\n' ' ')"
