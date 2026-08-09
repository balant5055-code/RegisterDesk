#!/usr/bin/env bash
# MC-05.6C · Multi-instance validation coordinator.
#
# Spawns N SEPARATE `vitest run` processes against ONE organizer. Separate processes mean
# separate module registries, so each has its own `organizerLock` map — the multi-instance
# condition a serverless deployment produces, which an in-process lock cannot cover.
#
#   ./scripts/loadtest/multiInstance.sh <photos-per-instance> <instances> <workers-per-instance>
#
# Requires the Firestore emulator. Never touches a real project — the test aborts unless
# GCLOUD_PROJECT starts with `demo-`.

set -u
PHOTOS="${1:-100}"
INSTANCES="${2:-4}"
WORKERS="${3:-4}"
OUT="${MC_OUT:-/tmp/mc056c}"
mkdir -p "$OUT"

export MC_SHARED_UID="emu-multi-$(date +%s)"
export MC_PHOTOS="$PHOTOS"
export MC_WORKERS="$WORKERS"
export MC_SEED=$(( PHOTOS * INSTANCES * 4 + 5000 ))

echo "── setup ─────────────────────────────────────────────"
MC_ROLE=setup npx dotenv -e .env.emulator -- npx vitest run tests/emulator/multiInstance.emu.test.ts --reporter=verbose \
  > "$OUT/setup.log" 2>&1
grep -E "\[setup\]|Tests " "$OUT/setup.log" | tail -2

echo "── ${INSTANCES} instances × ${PHOTOS} photos × ${WORKERS} workers ──"
START=$(date +%s%3N)
for i in $(seq 1 "$INSTANCES"); do
  MC_ROLE=worker MC_INSTANCE="$i" \
    npx dotenv -e .env.emulator -- npx vitest run tests/emulator/multiInstance.emu.test.ts --reporter=verbose \
    > "$OUT/worker$i.log" 2>&1 &
done
wait
END=$(date +%s%3N)
WALL=$(( END - START ))

echo "── per-instance results ──────────────────────────────"
grep -h "RESULT" "$OUT"/worker*.log || echo "(no results captured)"

echo "── wall clock: ${WALL} ms for $(( PHOTOS * INSTANCES )) photos ──"
node -e "
const total=$PHOTOS*$INSTANCES, ms=$WALL;
console.log('aggregate throughput:', (total/(ms/1000)).toFixed(2), 'photos/s');
"

echo "── verify ────────────────────────────────────────────"
MC_ROLE=verify npx dotenv -e .env.emulator -- npx vitest run tests/emulator/multiInstance.emu.test.ts --reporter=verbose \
  > "$OUT/verify.log" 2>&1
grep -E "\[verify\]|Tests |AssertionError|expected" "$OUT/verify.log" | tail -8
