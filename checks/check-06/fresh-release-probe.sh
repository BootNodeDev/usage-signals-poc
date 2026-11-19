#!/usr/bin/env bash
# Probe for "the same day": can Umami's install step take a Next.js release that is less than
# 24 hours old? It uses the newest canary of `next` as a stand-in for a security release
# published today. pnpm refuses locked versions younger than minimumReleaseAge (one day by
# default) unless they are listed in minimumReleaseAgeExclude, and it writes that list itself
# into pnpm-workspace.yaml while it regenerates the lockfile. The probe runs Umami's own
# install command (Dockerfile, deps stage) twice: with the lockfile and the override line only,
# and with pnpm-workspace.yaml as pnpm left it.
# Installs only; nothing is built. Exits 0 when the first install is refused and the second works.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UMAMI_TAG="v3.5.0"
UMAMI_COMMIT="d3c62a805beda8643cb468924dda38617fb4c286"
WORK="$(mktemp -d -t us-check-06-probe)"
TREE="$WORK/tree"

git clone -q -c advice.detachedHead=false --branch "$UMAMI_TAG" --depth 1 "file://$REPO/umami" "$TREE"
[ "$(git -C "$TREE" rev-parse HEAD)" = "$UMAMI_COMMIT" ] || {
  echo "unexpected commit"
  exit 1
}
NODE_IMAGE="node:$(sed -n 's/^ARG NODE_IMAGE_VERSION="\(.*\)"$/\1/p' "$TREE/Dockerfile")"
PNPM_VERSION="$(sed -n 's/^ARG PNPM_VERSION="\(.*\)"$/\1/p' "$TREE/Dockerfile")"

read -r VERSION AGE_HOURS <<<"$(docker run --rm "$NODE_IMAGE" node -e '
  fetch("https://registry.npmjs.org/next").then((r) => r.json()).then((p) => {
    const version = p["dist-tags"].canary;
    console.log(version, Math.floor((Date.now() - Date.parse(p.time[version])) / 3600000));
  })')"
echo "newest canary: next@$VERSION, published $AGE_HOURS h ago; scratch: $WORK"
[ "$AGE_HOURS" -lt 24 ] || {
  echo "No release under 24 hours old to probe with. Try again later."
  exit 2
}

pnpm_in() { # pnpm_in <directory> <pnpm arguments>
  local dir="$1"
  shift
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_prefix=/tmp/npm \
    -v "$dir:/app" -w /app "$NODE_IMAGE" \
    sh -c "npm install -g pnpm@$PNPM_VERSION >/dev/null 2>&1 && /tmp/npm/bin/pnpm $*"
}

# What the deps stage of Umami's Dockerfile copies in before `pnpm install --frozen-lockfile`.
deps_stage_copy() { # deps_stage_copy <destination> <pnpm-workspace.yaml to use>
  mkdir -p "$1/packages/api-client" "$1/packages/mcp"
  cp "$TREE/package.json" "$TREE/pnpm-lock.yaml" "$1/"
  cp "$2" "$1/pnpm-workspace.yaml"
  cp "$TREE/packages/api-client/package.json" "$1/packages/api-client/"
  cp "$TREE/packages/mcp/package.json" "$1/packages/mcp/"
  cp -R "$TREE/packages/mcp/bin" "$1/packages/mcp/bin"
  printf 'strictDepBuilds: false\n' >>"$1/pnpm-workspace.yaml"
}

cp "$TREE/pnpm-workspace.yaml" "$WORK/pnpm-workspace.before.yaml"
awk -v line="  next: $VERSION" '{ print } /^overrides:$/ { print line }' \
  "$WORK/pnpm-workspace.before.yaml" >"$WORK/pnpm-workspace.override-only.yaml"
cp "$WORK/pnpm-workspace.override-only.yaml" "$TREE/pnpm-workspace.yaml"

echo "1. regenerate the lockfile with the override"
pnpm_in "$TREE" install --lockfile-only >"$WORK/resolve.log" 2>&1
grep -q "^  next@$VERSION:" "$TREE/pnpm-lock.yaml" || {
  echo "the lockfile did not take next@$VERSION"
  exit 1
}
echo "   lines pnpm added to pnpm-workspace.yaml on its own:"
{ diff "$WORK/pnpm-workspace.override-only.yaml" "$TREE/pnpm-workspace.yaml" || true; } | sed -n 's/^> /     /p'

echo "2. frozen install: regenerated lockfile, pnpm-workspace.yaml with the override line only"
deps_stage_copy "$WORK/override-only" "$WORK/pnpm-workspace.override-only.yaml"
if pnpm_in "$WORK/override-only" install --frozen-lockfile --ignore-scripts >"$WORK/override-only.log" 2>&1; then
  echo "   installed: pnpm did not refuse the fresh release"
  REFUSED=0
else
  grep -m 1 -o 'ERR_PNPM_[A-Z_]*' "$WORK/override-only.log" | sed 's/^/   refused: /'
  REFUSED=1
fi

echo "3. frozen install: regenerated lockfile, pnpm-workspace.yaml as pnpm left it"
deps_stage_copy "$WORK/as-pnpm-left-it" "$TREE/pnpm-workspace.yaml"
pnpm_in "$WORK/as-pnpm-left-it" install --frozen-lockfile --ignore-scripts >"$WORK/as-pnpm-left-it.log" 2>&1 ||
  {
    echo "   failed, see $WORK/as-pnpm-left-it.log"
    exit 1
  }
INSTALLED="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$WORK/as-pnpm-left-it/node_modules/next/package.json")"
echo "   installed next@$INSTALLED"

if [ "$REFUSED" = 1 ] && [ "$INSTALLED" = "$VERSION" ]; then
  echo "RESULT: a release under 24 hours old installs only with the minimumReleaseAgeExclude entries pnpm wrote."
else
  echo "RESULT: unexpected (refused=$REFUSED, installed=$INSTALLED). The correction in README.md needs review."
  exit 1
fi
