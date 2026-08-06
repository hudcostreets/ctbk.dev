# ctbk derived image for pyrmts-engine Batch builds: base engine image
# + source factories (`-x ctbk_engine_src:<attr>`). See
# specs/engine-batch-packaging.md (pyrmts) — derived-image pattern (b).
#
# Build from the ctbk REPO ROOT (the context needs ctbk/ + configs/):
#   pyrmts-engine batch push -c . -f gbfs/engine/Dockerfile -p linux/arm64 \
#     006196295121.dkr.ecr.us-east-1.amazonaws.com/ctbk-engine:$(git rev-parse --short HEAD)
FROM 006196295121.dkr.ecr.us-east-1.amazonaws.com/pyrmts-engine:ce770e7

# `station_chain` vocab expansion (ctbk_vocab).
RUN pip install --no-cache-dir s2cell==1.8.0

# Flat-module copies: `raw_source.py` / `vocab.py` are deliberately
# ctbk-package-independent (pyrmts + stdlib + s2cell only), so they drop
# onto PYTHONPATH without the rest of the package.
COPY gbfs/engine/ctbk_engine_src.py /app/ctbk_engine_src.py
COPY ctbk/pyramid_cascade/raw_source.py /app/ctbk_raw_source.py
COPY ctbk/pyramid_cascade/vocab.py /app/ctbk_vocab.py
COPY configs/pyramids/station-vocab.json /app/station-vocab.json
ENV PYTHONPATH=/app
