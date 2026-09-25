#!/usr/bin/env bash
# Run CMD as the HCCS AWS `ctbk-gha` role (GitHub OIDC → STS; Pulumi-managed in
# `infra/aws_hccs.py`). The credentials exist only in CMD's environment, so a
# job whose other steps use `AWS_*` for R2 (e.g. `gbfs-compact`) is untouched.
# The job needs `permissions: id-token: write`.
set -euo pipefail
ROLE=arn:aws:iam::688066488567:role/ctbk-gha
token=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_ENDPOINT_URL AWS_PROFILE
export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < <(
  aws sts assume-role-with-web-identity --role-arn "$ROLE" \
    --role-session-name "gha-${GITHUB_RUN_ID:-local}" --web-identity-token "$token" \
    --duration-seconds "${HCCS_AWS_DURATION:-3600}" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
exec "$@"
