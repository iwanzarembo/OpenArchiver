#!/usr/bin/env bash
# Build one OpenArchiver image and load it into the local docker daemon;
# optionally push it to the Gitea registry.
#
# Registry cache (--cache) is used when the builder supports it. The default
# `docker` driver rejects cache export, so instead of failing the pipeline the
# build is repeated without cache flags (and the persistent local build cache
# still applies).
#
# Usage:
#   build-image.sh --tag <tag> [--target <stage>] [--cache <ref>] [--push]
#                  [--file <dockerfile>] [--label k=v] [--build-arg k=v]
set -euo pipefail

tag=""
target=""
cache=""
file="apps/open-archiver/Dockerfile"
push=false
build_args=()
labels=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag=${2:?--tag needs a value}; shift 2 ;;
    --target) target=${2:?--target needs a value}; shift 2 ;;
    --cache) cache=${2:?--cache needs a value}; shift 2 ;;
    --file) file=${2:?--file needs a value}; shift 2 ;;
    --push) push=true; shift ;;
    --build-arg) build_args+=("--build-arg" "${2:?--build-arg needs a value}"); shift 2 ;;
    --label) labels+=("--label" "${2:?--label needs a value}"); shift 2 ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$tag" ]; then
  echo "--tag is required" >&2
  exit 2
fi

args=(--load --file "$file" --tag "$tag")
if [ -n "$target" ]; then
  args+=(--target "$target")
fi
if [ ${#build_args[@]} -gt 0 ]; then
  args+=("${build_args[@]}")
fi
if [ ${#labels[@]} -gt 0 ]; then
  args+=("${labels[@]}")
fi

run_build() {
  docker buildx build "$@" "${args[@]}" .
}

# The `docker` driver (default on many installations) cannot export cache to a
# registry, only inline cache embedded in the image. Asking it anyway fails the
# whole build, so the driver is checked first.
supports_cache_export() {
  driver=$(docker buildx inspect 2>/dev/null \
    | awk '/^Driver:/ { print $2; exit }' || true)
  [ -n "$driver" ] && [ "$driver" != "docker" ]
}

if [ -n "$cache" ] && supports_cache_export; then
  if run_build --cache-from "type=registry,ref=$cache" \
               --cache-to "type=registry,ref=$cache,mode=max,ignore-error=true"; then
    echo "Build finished with registry cache ($cache)."
  else
    echo "WARN: build with registry cache failed, retrying without cache export." >&2
    run_build
    echo "Build finished."
  fi
else
  if [ -n "$cache" ]; then
    echo "Builder driver cannot export registry cache - using the local build cache."
  fi
  run_build
  echo "Build finished."
fi

echo "image: $tag"
docker image inspect --format 'image size: {{.Size}} bytes' "$tag"

if [ "$push" = true ]; then
  echo "pushing $tag"
  docker push "$tag"
fi
