#!/usr/bin/env bash

if [ $# -ne 1 ]; then
  echo "Usage: $0 yyyymm" >&2
  exit 1
fi
m="$1"; shift

set -ex

ctbk norm create $m
ctbk cons create $m
ctbk smh create -gil $m
ctbk smh create -gin $m
ctbk agg create -ge -ac $m
ctbk agg create -gse -ac $m
ctbk agg create -g ymrgtb -acd $m
ctbk sm create $m
ctbk spj create $m
ctbk ymrgtb-cd -f
