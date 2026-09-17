#!/usr/bin/env bash
#
# Roll Cloud Run traffic back to the previous healthy revision.
#
#   ./rollback.sh                      # previous revision
#   ./rollback.sh roxstar-backend-00007-abc
#
# CI does this automatically when post-deploy verification fails; this is the
# manual lever for when a problem is noticed later.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="roxstar-backend"

gcloud config set project "$PROJECT_ID" >/dev/null

TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  # Second newest: the newest is the one currently serving and presumably bad.
  TARGET="$(gcloud run revisions list \
    --service "$SERVICE" --region "$REGION" \
    --format='value(metadata.name)' --sort-by='~metadata.creationTimestamp' \
    | sed -n '2p')"
fi

if [ -z "$TARGET" ]; then
  echo "No previous revision found. Nothing to roll back to." >&2
  exit 1
fi

echo "Rolling traffic to: $TARGET"
gcloud run services update-traffic "$SERVICE" \
  --region "$REGION" --to-revisions "${TARGET}=100"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

echo "Confirming health after rollback..."
curl -sf "${URL}/health" && echo
curl -sf "${URL}/ready"  && echo

echo
echo "Rolled back to $TARGET. Verify properly with:"
echo "  node tests/e2e/verify.mjs $URL"
