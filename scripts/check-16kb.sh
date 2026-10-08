#!/usr/bin/env bash
# Checks an APK for Google Play's 16 KB memory page size requirement (updates must comply from
# Feb 1, 2027). Two things must hold, and either one alone is not enough:
#   1. every 64-bit native library is stored uncompressed and 16 KB-aligned inside the zip
#      (zipalign -P 16), and
#   2. every ELF LOAD segment in those libraries is aligned to at least 16 KB (p_align >= 0x4000).
# Usage: scripts/check-16kb.sh path/to/app.apk   (needs unzip, readelf, and zipalign from build-tools)
set -euo pipefail

apk="${1:?usage: $0 path/to/app.apk}"
zipalign_bin="${ZIPALIGN:-}"
if [[ -z "$zipalign_bin" ]]; then
  zipalign_bin="$(ls -d "${ANDROID_HOME:-/nonexistent}"/build-tools/*/zipalign 2>/dev/null | sort -V | tail -n 1 || true)"
fi
[[ -x "$zipalign_bin" ]] || { echo "check-16kb: zipalign not found (set ZIPALIGN or ANDROID_HOME)" >&2; exit 2; }
command -v readelf >/dev/null || { echo "check-16kb: readelf not found (install binutils)" >&2; exit 2; }

status=0

echo "check-16kb: zip alignment ($zipalign_bin -c -P 16 4)"
if ! "$zipalign_bin" -c -P 16 4 "$apk" >/dev/null; then
  "$zipalign_bin" -c -P 16 -v 4 "$apk" | grep -v '(OK' || true
  echo "check-16kb: FAIL zip alignment" >&2
  status=1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q -o "$apk" 'lib/arm64-v8a/*.so' 'lib/x86_64/*.so' -d "$work" 2>/dev/null || true

count=0
while IFS= read -r -d '' so; do
  count=$((count + 1))
  # Smallest alignment among the LOAD segments (the last column of `readelf -lW`, in hex).
  min_align=""
  while read -r hex; do
    value=$((16#${hex#0x}))
    if [[ -z "$min_align" || "$value" -lt "$min_align" ]]; then min_align="$value"; fi
  done < <(readelf -lW "$so" | awk '$1 == "LOAD" { print $NF }')
  if [[ -z "$min_align" || "$min_align" -lt 16384 ]]; then
    echo "check-16kb: FAIL ${so#"$work"/} LOAD alignment ${min_align:-unknown} < 16384" >&2
    status=1
  fi
done < <(find "$work/lib" -name '*.so' -print0 2>/dev/null)

if [[ "$count" -eq 0 ]]; then
  echo "check-16kb: no 64-bit native libraries found in $apk" >&2
  exit 1
fi
if [[ "$status" -eq 0 ]]; then
  echo "check-16kb: OK ($count 64-bit native libraries, zip and ELF alignment both 16 KB)"
fi
exit "$status"
