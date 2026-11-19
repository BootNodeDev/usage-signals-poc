#!/usr/bin/env bash
# Check 6: "Umami v3.5.0 rebuilds with a bumped Next.js and passes the contract tests the same day."
#
#   ./run.sh                    clone the tag, apply override.yaml, build, test, print the verdict
#   NEXT_VERSION=16.4.5 ./run.sh   same, with another Next.js version than the one in override.yaml
#   IMAGE=<ref> ./run.sh        skip the rebuild and run the suite against an existing image
#                               (the upstream image gives the control run)
#
# Exits 0 only when the image builds, runs the Next.js version the override names, and the
# console suite reports EXPECTED_TESTS passing and none failing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CONSOLE="$REPO/console"

UMAMI_TAG="v3.5.0"
UMAMI_COMMIT="d3c62a805beda8643cb468924dda38617fb4c286"
UMAMI_REMOTE="https://github.com/umami-software/umami.git"
EXPECTED_TESTS=112
PROJECT="us-check-06"
PG_PORT=55106
UMAMI_PORT=33106
UMAMI_NOGEO_PORT=33206
RUNNER_IMAGE="node:24.22.1-alpine"

NEXT_VERSION="${NEXT_VERSION:-$(awk '$1 == "next:" { print $2 }' "$HERE/override.yaml")}"
IMAGE="${IMAGE:-}"
REBUILD=1
if [ -n "$IMAGE" ]; then REBUILD=0; else IMAGE="usage-signals/umami:3.5.0-next$NEXT_VERSION"; fi

WORK="$(mktemp -d -t us-check-06)"
TREE="$WORK/tree"
declare -a TIMINGS=()

say() { printf '\n[check-06 %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() {
  printf '\nVERDICT: FAIL - %s\nscratch: %s\n' "$*" "$WORK"
  exit 1
}
timed() { # timed <label> <command...>
  local label="$1" start=$SECONDS
  shift
  "$@"
  TIMINGS+=("$label: $((SECONDS - start)) s")
}

cleanup() {
  docker rm -f "$PROJECT-runner" >/dev/null 2>&1 || true
  UMAMI_IMAGE="$IMAGE" docker compose -p "$PROJECT" -f "$HERE/compose.yml" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

preflight() {
  command -v docker >/dev/null || fail "docker is not installed"
  [ -d "$CONSOLE/node_modules/pg" ] || fail "run 'pnpm install --ignore-scripts' in console/ first"
  local port
  for port in $PG_PORT $UMAMI_PORT $UMAMI_NOGEO_PORT; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "port $port is in use"
    fi
  done
  if [ "$REBUILD" = 1 ]; then
    # One uncached build leaves about 4 GB of layers and build cache in Docker's disk.
    local free_kb
    free_kb="$(docker run --rm "$RUNNER_IMAGE" df -k / | awk 'END { print $4 }')"
    [ "$free_kb" -ge $((6 * 1024 * 1024)) ] || fail "Docker's disk has $((free_kb / 1024)) MB free; the build needs 6 GB"
  fi
}

clone_tag() {
  local source="$REPO/umami"
  if ! git -C "$source" rev-parse -q --verify "$UMAMI_TAG^{commit}" >/dev/null 2>&1; then
    source="$UMAMI_REMOTE"
  else
    source="file://$source"
  fi
  git clone -q -c advice.detachedHead=false --branch "$UMAMI_TAG" --depth 1 "$source" "$TREE"
  local head
  head="$(git -C "$TREE" rev-parse HEAD)"
  [ "$head" = "$UMAMI_COMMIT" ] || fail "tag $UMAMI_TAG is $head, expected $UMAMI_COMMIT"
}

# The package manager and Node versions are the ones Umami's own Dockerfile declares.
dockerfile_arg() { sed -n "s/^ARG $1=\"\(.*\)\"$/\1/p" "$TREE/Dockerfile"; }

pnpm_in_container() { # runs pnpm in the tree, as the calling user, with Umami's pnpm version
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_prefix=/tmp/npm \
    -v "$TREE:/app" -w /app "node:$(dockerfile_arg NODE_IMAGE_VERSION)" \
    sh -c "npm install -g pnpm@$(dockerfile_arg PNPM_VERSION) >/dev/null 2>&1 && /tmp/npm/bin/pnpm $*"
}

apply_override() {
  cp "$TREE/pnpm-workspace.yaml" "$WORK/pnpm-workspace.before.yaml"
  cp "$TREE/pnpm-lock.yaml" "$WORK/pnpm-lock.before.yaml"
  sed "s/^  next: .*/  next: $NEXT_VERSION/" "$HERE/override.yaml" >"$WORK/override.yaml"
  awk -v block="$WORK/override.yaml" \
    '{ print } /^overrides:$/ { while ((getline line < block) > 0) print line }' \
    "$WORK/pnpm-workspace.before.yaml" >"$TREE/pnpm-workspace.yaml"
  pnpm_in_container install --lockfile-only | grep -v 'Update available\|Changelog\|To update' || true
  grep -q "^  next@$NEXT_VERSION:" "$TREE/pnpm-lock.yaml" || fail "the lockfile does not resolve next@$NEXT_VERSION"
}

assert_only_recipe_files_changed() {
  local changed
  changed="$(git -C "$TREE" status --porcelain | sort | tr '\n' ' ')"
  [ "$changed" = " M pnpm-lock.yaml  M pnpm-workspace.yaml " ] ||
    fail "files other than the lockfile and pnpm-workspace.yaml changed: $changed"
  git -C "$TREE" diff >"$WORK/recipe.diff"
  echo "changed files: pnpm-lock.yaml, pnpm-workspace.yaml (diff: $WORK/recipe.diff)"
  git -C "$TREE" diff --stat | tail -3
  echo "lockfile packages removed / added:"
  diff <(lock_packages "$WORK/pnpm-lock.before.yaml") <(lock_packages "$TREE/pnpm-lock.yaml") | grep '^[<>]' || true
}

lock_packages() {
  awk '/^packages:$/ { on = 1; next } /^snapshots:$/ { on = 0 }
       on && /^  [^ ].*:$/ { gsub(/^  |:$|\047/, ""); print }' "$1" | sort
}

build_image() {
  docker build --no-cache --progress=plain -t "$IMAGE" "$TREE" >"$WORK/build.log" 2>&1 ||
    {
      grep -n -m 5 -E 'ERROR|ERR_|error:' "$WORK/build.log" || true
      fail "docker build failed, see $WORK/build.log"
    }
}

assert_runtime_version() {
  local built
  built="$(docker run --rm --entrypoint node "$IMAGE" -p "require('/app/node_modules/next/package.json').version")"
  echo "Next.js in the image: $built; banner in the build log: $(grep -o -m 1 'Next.js [0-9][^ ]*' "$WORK/build.log")"
  [ "$built" = "$NEXT_VERSION" ] || fail "the image runs Next.js $built, not $NEXT_VERSION: the override was ignored"
  local compiled
  compiled="$(docker run --rm --entrypoint sh "$IMAGE" -c "grep -rlF '$NEXT_VERSION' /app/.next/server /app/.next/static | wc -l")"
  echo "compiled files in .next that name $NEXT_VERSION: $((compiled))"
  [ "$((compiled))" -gt 0 ] || fail "the compiled output does not name Next.js $NEXT_VERSION"
}

run_suite() {
  UMAMI_IMAGE="$IMAGE" docker compose -p "$PROJECT" -f "$HERE/compose.yml" up -d --wait >"$WORK/stack.log" 2>&1 ||
    {
      docker logs --tail 5 "$PROJECT-postgres-1" 2>&1 || true
      fail "the stack did not start, see $WORK/stack.log"
    }
  local running
  running="$(docker inspect --format '{{.Image}}' "$PROJECT-umami-1")"
  [ "$running" = "$(docker image inspect --format '{{.Id}}' "$IMAGE")" ] || fail "the stack is not running $IMAGE"
  echo "stack runs image $running"
  echo "Next.js in the running container: $(docker exec "$PROJECT-umami-1" node -p "require('/app/node_modules/next/package.json').version")"

  # Seed, local server and suite run in one container on the stack's network, so that the
  # local server can listen on the ports of local.env (one test needs the demo site on
  # localhost:4301) and the suite's fixed ports cannot collide with anything on the host.
  # The Docker socket is there for the one test that runs `docker compose exec postgres pg_dump`.
  docker run --rm --name "$PROJECT-runner" --network "${PROJECT}_default" \
    -v "$CONSOLE:$CONSOLE:ro" -v /var/run/docker.sock:/var/run/docker.sock -w "$CONSOLE" \
    -e COMPOSE_PROJECT_NAME="$PROJECT" \
    -e DATABASE_URL="postgresql://poc:poc-local-only@postgres:5432/poc" \
    -e DATABASE_URL_UNPOOLED="postgresql://poc:poc-local-only@postgres:5432/poc" \
    -e UMAMI_URL="http://umami:3000" -e UMAMI_NOGEO_URL="http://umami-nogeo:3000" \
    "$RUNNER_IMAGE" sh -c '
      set -eu
      apk add --no-cache docker-cli docker-cli-compose >/dev/null
      node --env-file=local.env scripts/seed.mjs
      node --env-file=local.env dev.mjs >/tmp/dev.log 2>&1 &
      for _ in $(seq 1 50); do
        if wget -qO /dev/null http://localhost:4300/s/manifest.json; then break; fi
        sleep 0.2
      done
      npm test
    ' >"$WORK/test.log" 2>&1 || true
}

summary_count() { sed -n "s/^ℹ $1 \([0-9][0-9]*\)$/\1/p" "$WORK/test.log" | tail -1; }

preflight
say "scratch directory: $WORK"
if [ "$REBUILD" = 1 ]; then
  say "clone Umami $UMAMI_TAG"
  timed "clone" clone_tag
  say "apply the override (next $NEXT_VERSION) and regenerate the lockfile"
  timed "resolve (override + lockfile)" apply_override
  assert_only_recipe_files_changed
  say "build the image with Umami's Dockerfile (log: $WORK/build.log)"
  timed "install + build (docker build --no-cache)" build_image
  assert_runtime_version
  docker image inspect --format 'image id: {{.Id}}  size: {{.Size}} bytes' "$IMAGE"
fi
say "start the isolated stack on $IMAGE, seed it, run the console suite"
timed "stack up + seed + suite" run_suite

TESTS="$(summary_count tests)"
PASSED="$(summary_count pass)"
FAILED="$(summary_count fail)"
say "result"
printf 'image: %s\nsuite: %s tests, %s pass, %s fail (expected %s pass); log: %s\n' \
  "$IMAGE" "${TESTS:-?}" "${PASSED:-?}" "${FAILED:-?}" "$EXPECTED_TESTS" "$WORK/test.log"
printf '%s\n' "${TIMINGS[@]}"
printf 'total: %s s\nscratch: %s\n' "$SECONDS" "$WORK"

if [ "${PASSED:-0}" != "$EXPECTED_TESTS" ] || [ "${FAILED:-1}" != 0 ]; then
  grep -E '^(✖|not ok)' "$WORK/test.log" | sort -u | head -40 || true
  fail "the suite did not report $EXPECTED_TESTS passing and 0 failing"
fi
if [ "$REBUILD" = 1 ]; then
  echo "VERDICT: PASS - Umami $UMAMI_TAG rebuilt with next $NEXT_VERSION from an override and a regenerated"
  echo "lockfile only, and the console suite passes $PASSED/$EXPECTED_TESTS against it."
else
  echo "CONTROL: the console suite passes $PASSED/$EXPECTED_TESTS against $IMAGE."
fi
