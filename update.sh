#!/usr/bin/env bash
# DEPRECATED: the monthly pipeline is now driven by `ctbk update` (ctbk/update.py),
# a superset of the old command sequence this script used to hardcode. CI invokes
# `ctbk update -S <YYYYMM>`. This shim just forwards to it.

if [ $# -ne 1 ]; then
  echo "Usage: $0 yyyymm" >&2
  exit 1
fi

echo "update.sh is deprecated; running: ctbk update -S $1" >&2
exec ctbk update -S "$1"
