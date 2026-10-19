#!/usr/bin/env bash
# Configura el acceso SIN CLAVE de GitHub Actions a Earth Engine (Workload Identity Federation).
# Correrlo una sola vez en Google Cloud Shell (console.cloud.google.com → ícono >_ arriba a la derecha):
#   bash configurar_google.sh
set -euo pipefail
PROYECTO=the-byway-494216-n2
REPO=diegoesteve/predinun
CUENTA=predinun
gcloud config set project "$PROYECTO"
NUM=$(gcloud projects describe "$PROYECTO" --format='value(projectNumber)')
SA="$CUENTA@$PROYECTO.iam.gserviceaccount.com"

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com earthengine.googleapis.com

gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$CUENTA" --display-name="predinun (GitHub Actions)"
for ROL in roles/earthengine.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROYECTO" --member="serviceAccount:$SA" --role="$ROL" --condition=None >/dev/null
done

gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers describe predinun --location=global --workload-identity-pool=github >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc predinun --location=global --workload-identity-pool=github \
    --display-name="predinun" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='$REPO'"

# Solo los workflows de este repositorio pueden usar la cuenta de servicio
gcloud iam service-accounts add-iam-policy-binding "$SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" >/dev/null

echo
echo "Listo. Cargá estos secretos en GitHub (Settings → Secrets and variables → Actions):"
echo "  GCP_WIF_PROVIDER     projects/$NUM/locations/global/workloadIdentityPools/github/providers/predinun"
echo "  GCP_SERVICE_ACCOUNT  $SA"
echo "  EE_PROJECT           $PROYECTO"
