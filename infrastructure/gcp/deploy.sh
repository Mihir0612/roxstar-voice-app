#!/usr/bin/env bash
#
# One-shot GCP deployment without Terraform.
#
# Terraform in ../terraform is the reproducible path and the one to prefer.
# This script exists for a first deploy or a live demo, where watching each
# resource appear is more useful than a state file.
#
#   export GCP_PROJECT_ID=my-project
#   ./deploy.sh
#
# Idempotent: every step tolerates the resource already existing.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="roxstar-backend"
REPO="roxstar"
SQL_INSTANCE="roxstar-postgres"
DB_NAME="roxstar"
DB_USER="roxstar_app"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"

# Repo root, so `docker build .` gets both /backend and /database.
cd "$(dirname "$0")/../.."

say() { printf '\n=== %s ===\n' "$1"; }

say "Project setup"
gcloud config set project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

say "Artifact Registry"
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" \
  --description="Roxstar backend images" 2>/dev/null || echo "  already exists"

say "Cloud SQL (this takes several minutes on first run)"
gcloud sql instances create "$SQL_INSTANCE" \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region="$REGION" \
  --storage-size=10GB \
  --storage-auto-increase \
  --backup-start-time=03:00 2>/dev/null || echo "  already exists"

gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" 2>/dev/null || echo "  database already exists"

# Generated here and never printed. If the user already exists we keep the
# existing password, because rotating it would break the running revision.
if ! gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
  DB_PASSWORD="$(openssl rand -base64 24)"
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD"
  CREATED_USER=1
else
  echo "  database user already exists; reusing the stored secret"
  CREATED_USER=0
fi

CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"

say "Secrets"
# Values reach Secret Manager through stdin -- never as a command-line
# argument, which would land in shell history and in the process table (D29).
if [ "$CREATED_USER" = "1" ]; then
  printf 'postgres://%s:%s@localhost/%s?host=/cloudsql/%s' \
    "$DB_USER" "$DB_PASSWORD" "$DB_NAME" "$CONNECTION_NAME" \
    | gcloud secrets create roxstar-database-url --data-file=- 2>/dev/null \
    || printf 'postgres://%s:%s@localhost/%s?host=/cloudsql/%s' \
         "$DB_USER" "$DB_PASSWORD" "$DB_NAME" "$CONNECTION_NAME" \
         | gcloud secrets versions add roxstar-database-url --data-file=-
fi

if ! gcloud secrets describe roxstar-auth-secret >/dev/null 2>&1; then
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets create roxstar-auth-secret --data-file=-
else
  echo "  auth secret already exists; leaving it alone"
fi

say "Runtime service account"
gcloud iam service-accounts create roxstar-run \
  --display-name="Roxstar Cloud Run runtime" 2>/dev/null || echo "  already exists"

RUNTIME_SA="roxstar-run@${PROJECT_ID}.iam.gserviceaccount.com"

# Exactly two grants: read these secrets, connect to Cloud SQL.
for SECRET in roxstar-database-url roxstar-auth-secret; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/cloudsql.client --quiet >/dev/null

say "Build and push image"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

say "Deploy to Cloud Run"
# --session-affinity and --timeout 3600 are what make WebSockets work here;
# min/max instances 1 is the D27 single-instance decision.
gcloud run deploy "$SERVICE" \
  --image "${IMAGE}:${TAG}" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --session-affinity \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 1 \
  --cpu 1 --memory 512Mi \
  --no-cpu-throttling \
  --service-account "$RUNTIME_SA" \
  --add-cloudsql-instances "$CONNECTION_NAME" \
  --set-env-vars "NODE_ENV=production,DATABASE_SSL=false,LOG_LEVEL=info,CORS_ALLOWED_ORIGINS=" \
  --set-secrets "DATABASE_URL=roxstar-database-url:latest,AUTH_SECRET=roxstar-auth-secret:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

say "Verify"
echo "Endpoint: $URL"
curl -sf "${URL}/health" && echo
curl -sf "${URL}/ready"  && echo

cat <<MSG

Deployed, but NOT yet verified. Uploading is not deploying.
Run the full end-to-end check before calling this done:

  cd tests && npm ci && node e2e/verify.mjs "$URL"

Then point the Android release build at it:

  android-app/gradle.properties ->  ROXSTAR_API_BASE_URL=$URL

MSG
