# ctbk derived image for pyrmts-engine Batch builds: base engine image
# + source factories (`-x ctbk_engine_src:<attr>`). See
# specs/engine-batch-packaging.md (pyrmts) — derived-image pattern (b).
FROM 006196295121.dkr.ecr.us-east-1.amazonaws.com/pyrmts-engine:652cee0
COPY ctbk_engine_src.py /app/ctbk_engine_src.py
ENV PYTHONPATH=/app
