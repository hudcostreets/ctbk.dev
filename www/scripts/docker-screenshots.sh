#!/bin/bash
# Generate screenshots in Docker to match GHA Ubuntu environment
set -e

cd "$(dirname "$0")/.."

# Build the Docker image
docker build -f Dockerfile.screenshots -t ctbk-screenshots .

# Run and copy screenshots out
docker run --rm -v "$PWD/public/screenshots:/app/public/screenshots" ctbk-screenshots
