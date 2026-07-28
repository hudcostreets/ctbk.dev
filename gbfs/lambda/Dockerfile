# Cascade-Lambda container image (replaces the zip + AWSSDKPandas-layer
# deployment — pyrmts `specs/pyrmts-ops-adoption.md` P2/P3 blocker: the
# shared pyrmts modules need polars, which can't vendor into a zip).
# Pinned writer env, same philosophy as the Batch engine image.
#
# Build context: the staged dir assembled by `deploy-image.py`
# (handler + configs + trimmed ctbk package + pyrmts wheels) — NOT the
# repo root (multi-GB s3/ tree; and the www build owns root dockerignore
# concerns).
FROM public.ecr.aws/lambda/python:3.12-arm64

COPY wheels/ /tmp/wheels/
RUN pip install --no-cache-dir \
    polars pyarrow pandas numpy pyyaml s2cell utz \
    /tmp/wheels/*.whl \
    && rm -rf /tmp/wheels

COPY handler.py ${LAMBDA_TASK_ROOT}/handler.py
COPY configs/ ${LAMBDA_TASK_ROOT}/
COPY ctbk/ ${LAMBDA_TASK_ROOT}/ctbk/

CMD ["handler.lambda_handler"]
