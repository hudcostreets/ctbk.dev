#!/bin/bash
# Compose an og:image mosaic: dark stations map (left) + 2 stacked DM plots (right)
# Layout: map fills left ~70%, 2 near-square plots on right ~30% with gap between.
# Requires: ImageMagick (magick)
set -e

cd "$(dirname "$0")/.."

SS=public/screenshots
OUT="$SS/ctbk-og-mosaic.png"
TMP="${TMPDIR:-/tmp}"

# === Layout constants ===
W=1200
H=630
GAP=4           # gap between elements
BG='#333333'    # subtle dark gray gap/border color

# RHS plots: width chosen so slot AR ≈ source chart AR (720:540 = 4:3)
# Slot: RW × 313; for 4:3 → RW = 313 × 4/3 ≈ 417
RW=420
# LHS map
LW=$((W - RW - GAP))   # 776
RX=$((LW + GAP))       # 780

# Plot heights: 2 plots with 1 gap
# 2×PH + GAP = 630 → PH = (630 - 4) / 2 = 313
PH=313

# Source og-plot screenshots are 720×626; crop off "Examples" section at bottom,
# then scale to target. Chart+controls area is ~540px of the 626px viewport.
CROP_H=540   # keep top 540px (title + chart + legend + controls)

# === Generate components ===

# Map: scale up 130%, crop to LW×H from center (zooms in, avoids title overlay)
magick "$SS/ctbk-stations.png" \
  -resize '130%' \
  -gravity center -crop "${LW}x${H}+0+0" +repage \
  "$TMP/og-map.png"

# Plots: crop off bottom (Examples section), then scale to target
magick "$SS/og-rides.png"         -crop "720x${CROP_H}+0+0" +repage -resize "${RW}x${PH}!" "$TMP/og-p1.png"
magick "$SS/og-ebike-minutes.png" -crop "720x${CROP_H}+0+0" +repage -resize "${RW}x${PH}!" "$TMP/og-p2.png"

# === Compose final image ===
Y2=$((PH + GAP))

magick -size "${W}x${H}" "xc:${BG}" \
  "$TMP/og-map.png"  -geometry "+0+0"       -composite \
  "$TMP/og-p1.png"   -geometry "+${RX}+0"   -composite \
  "$TMP/og-p2.png"   -geometry "+${RX}+${Y2}" -composite \
  "$OUT"

DIMS=$(identify -format '%wx%h' "$OUT")
echo "Created $OUT ($DIMS, $(wc -c < "$OUT" | tr -d ' ') bytes)"

rm -f "$TMP"/og-map.png "$TMP"/og-p[1-2].png
