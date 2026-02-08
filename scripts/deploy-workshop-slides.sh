#!/bin/bash
# ----------------------------------------------------------------------------
# deploy-workshop-slides.sh - Deploy the workshop slide deck
#
# This script:
# 1. Creates the workshop-slides namespace
# 2. Sets up image pull permissions from demo-builds
# 3. Applies updated Tekton triggers (including workshop-slides)
# 4. Creates the ArgoCD Application
# 5. Triggers the first build via Tekton PipelineRun
#
# Usage: ./scripts/deploy-workshop-slides.sh
# ----------------------------------------------------------------------------
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REGISTRY="image-registry.openshift-image-registry.svc:5000"
BUILD_NS="demo-builds"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${GREEN}[INFO]${NC}  $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

oc whoami > /dev/null 2>&1 || err "Not logged in. Run 'oc login' first."

CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null)
[ -z "$CLUSTER_DOMAIN" ] && err "Could not detect cluster domain."

# 1. Create namespace
log "Creating namespace workshop-slides..."
oc new-project workshop-slides --display-name="Workshop - Slide Deck" 2>/dev/null || \
  oc project workshop-slides 2>/dev/null || true

# 2. Image pull permissions
log "Setting up image pull permissions..."
oc policy add-role-to-group system:image-puller \
  "system:serviceaccounts:workshop-slides" -n "$BUILD_NS" 2>/dev/null || true

# 3. Apply Tekton triggers (updated with workshop-slides)
log "Applying Tekton triggers..."
oc apply -f "$REPO_ROOT/pipelines/03-trigger.yaml"

# 4. Create BuildConfig for manual first build
log "Creating BuildConfig (if not exists)..."
oc get bc workshop-slides -n "$BUILD_NS" > /dev/null 2>&1 || \
  oc new-build --name=workshop-slides --binary --strategy=docker -n "$BUILD_NS"

# 5. Build the image
log "Building workshop-slides image..."
oc start-build workshop-slides \
  --from-dir="$REPO_ROOT/apps/workshop-slides" \
  -n "$BUILD_NS" --follow

# 6. Apply ArgoCD Application
log "Creating ArgoCD Application..."
oc apply -f "$REPO_ROOT/gitops/argocd/workshop-slides.yaml"

# 7. Wait for ArgoCD sync
log "Waiting for ArgoCD to sync..."
sleep 10

# 8. Check deployment
log "Checking deployment status..."
oc rollout status deployment/workshop-slides -n workshop-slides --timeout=120s 2>/dev/null || \
  log "Deployment is still rolling out. Check ArgoCD for status."

ROUTE_URL=$(oc get route workshop-slides -n workshop-slides -o jsonpath='{.spec.host}' 2>/dev/null || echo "pending")

echo ""
echo "============================================================"
echo "  Workshop Slides deployed!"
echo ""
echo "  URL: https://$ROUTE_URL"
echo ""
echo "  Press S in the presentation to see speaker notes."
echo "  Use arrow keys to navigate."
echo "============================================================"
