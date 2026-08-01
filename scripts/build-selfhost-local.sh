#!/usr/bin/env bash
# Fast local build + push of self-host image (WSL or Linux Docker).
#
# Why faster than Actions:
#   - local BuildKit layer cache (warm after first build)
#   - no CI queue
#   - optional registry cache on GHCR
#
# Prerequisites:
#   - Docker (Desktop with WSL2 backend, or Linux)
#   - Logged into GHCR:  gh auth token | docker login ghcr.io -u USERNAME --password-stdin
#   - Repo root: Documents/executor (or set EXECUTOR_ROOT)
#
# Usage:
#   ./scripts/build-selfhost-local.sh              # build + push :lab
#   ./scripts/build-selfhost-local.sh --no-push    # build only (tag local)
#   ./scripts/build-selfhost-local.sh --deploy     # build + push + ssh lab-agents pull/up
#   ./scripts/build-selfhost-local.sh --tag dev    # tag :dev instead of :lab
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_BASE="${EXECUTOR_IMAGE_BASE:-ghcr.io/tzarebczan/executor-selfhost}"
TAG="${EXECUTOR_IMAGE_TAG:-lab}"
PLATFORM="${EXECUTOR_PLATFORM:-linux/amd64}"
PUSH=1
DEPLOY=0
EXTRA_TAGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push) PUSH=0; shift ;;
    --deploy) DEPLOY=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

IMAGE="${IMAGE_BASE}:${TAG}"
SHA_TAG="${IMAGE_BASE}:sha-$(git -C "$ROOT" rev-parse --short HEAD)"
export DOCKER_BUILDKIT=1

echo "==> root:     $ROOT"
echo "==> image:    $IMAGE"
echo "==> platform: $PLATFORM"
echo "==> push:     $PUSH  deploy: $DEPLOY"

cd "$ROOT"

# Prefer buildx for --cache-to/--platform
if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx required" >&2
  exit 1
fi

# Ensure a builder that can push multi/platform and use cache
if ! docker buildx inspect executor-local >/dev/null 2>&1; then
  docker buildx create --name executor-local --use --driver docker-container 2>/dev/null \
    || docker buildx use executor-local
else
  docker buildx use executor-local
fi

DOCKERFILE="${DOCKERFILE:-apps/host-selfhost/Dockerfile.fast}"
echo "==> dockerfile: $DOCKERFILE"

BUILD_ARGS=(
  -f "$DOCKERFILE"
  --platform "$PLATFORM"
  -t "$IMAGE"
  -t "$SHA_TAG"
  --build-arg BUILDKIT_INLINE_CACHE=1
  # Pull previous :lab for cache (best-effort)
  --cache-from "type=registry,ref=${IMAGE_BASE}:lab"
  --cache-from "type=registry,ref=${IMAGE_BASE}:buildcache"
)

if [[ "$PUSH" -eq 1 ]]; then
  # Registry cache for next local/CI build
  BUILD_ARGS+=(
    --cache-to "type=registry,ref=${IMAGE_BASE}:buildcache,mode=max"
    --push
  )
  # Need ghcr login
  if ! docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
    :
  fi
  if ! grep -q ghcr.io ~/.docker/config.json 2>/dev/null \
    && ! docker system info 2>/dev/null | grep -qi 'Username'; then
    echo "==> docker login ghcr.io (using gh auth token)"
    if command -v gh >/dev/null 2>&1; then
      gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
    else
      echo "Log in first: echo \$GITHUB_TOKEN | docker login ghcr.io -u USER --password-stdin" >&2
      exit 1
    fi
  fi
else
  # load into local docker engine (single platform only)
  BUILD_ARGS+=(--load)
fi

echo "==> docker buildx build …"
time docker buildx build "${BUILD_ARGS[@]}" "$ROOT"

echo "==> built $IMAGE and $SHA_TAG"

if [[ "$DEPLOY" -eq 1 ]]; then
  LAB_HOST="${LAB_HOST:-lab-agents}"
  echo "==> deploy on $LAB_HOST"
  ssh -o BatchMode=yes "$LAB_HOST" "sudo docker pull ${IMAGE} && cd /opt/lab/executor && sudo EXECUTOR_IMAGE=${IMAGE} docker compose up -d --force-recreate && sleep 5 && curl -sf http://127.0.0.1:4788/api/health && echo"
  echo "==> done"
fi
