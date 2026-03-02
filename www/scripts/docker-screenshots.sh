#!/bin/bash
# Generate screenshots in Docker to match GHA Ubuntu environment.
# Uses --platform linux/amd64 for byte-identical output with GHA (x64 runners).
set -e

cd "$(dirname "$0")/.."

PLATFORM="linux/amd64"
IMAGE="ctbk-screenshots"
CONTAINER="ctbk-screenshots-run"

# Build the Docker image (x64, matching GHA runners)
docker build --platform "$PLATFORM" -f Dockerfile.screenshots -t "$IMAGE" .

# Run, copy screenshots out, clean up
docker rm "$CONTAINER" 2>/dev/null || true
docker run --platform "$PLATFORM" --name "$CONTAINER" "$IMAGE"
docker cp "$CONTAINER:/app/public/screenshots/." public/screenshots/
docker rm "$CONTAINER"
