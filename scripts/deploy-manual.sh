#!/bin/bash
# =============================================================================
# Manual Deploy Script - Fallback
# Deploys all workshop apps using oc commands (no Pipelines, no GitOps).
# Run from the repo root: ./scripts/deploy-manual.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REGISTRY="image-registry.openshift-image-registry.svc:5000"
BUILD_NS="demo-builds"
CLUSTER_DOMAIN=""  # auto-detected below

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
check_login() {
  log "Checking OpenShift login..."
  oc whoami > /dev/null 2>&1 || err "Not logged in. Run 'oc login' first."
  log "Logged in as: $(oc whoami)"
}

detect_cluster_domain() {
  CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null)
  [ -z "$CLUSTER_DOMAIN" ] && err "Could not detect cluster apps domain."
  log "Cluster domain: $CLUSTER_DOMAIN"
}

# ---------------------------------------------------------------------------
# 1. Create projects (if they don't exist)
# ---------------------------------------------------------------------------
ensure_project() {
  local ns="$1"
  local display="$2"
  if oc get project "$ns" > /dev/null 2>&1; then
    log "Project '$ns' already exists."
  else
    log "Creating project '$ns'..."
    oc new-project "$ns" --display-name="$display"
  fi
}

create_projects() {
  log "--- Creating projects ---"
  ensure_project "demo-builds"    "Demo - Builds"
  ensure_project "app-bom"        "App Bom - Boas Praticas"
  ensure_project "app-ruim"       "App Ruim - Anti-pattern"
  ensure_project "demo-dashboard" "Demo - Dashboard"
  ensure_project "vpa-demo"       "VPA Demo - Workload Simulator"
}

# ---------------------------------------------------------------------------
# 2. Create BuildConfigs and ImageStreams (if they don't exist)
# ---------------------------------------------------------------------------
ensure_build_config() {
  local app="$1"
  local dir="$2"

  if oc get bc "$app" -n "$BUILD_NS" > /dev/null 2>&1; then
    log "BuildConfig '$app' already exists in $BUILD_NS."
  else
    log "Creating BuildConfig '$app' in $BUILD_NS..."
    oc new-build --name="$app" --binary --strategy=docker -n "$BUILD_NS"
  fi
}

create_build_configs() {
  log "--- Creating BuildConfigs ---"
  ensure_build_config "stress-app"         "apps/stress-app"
  ensure_build_config "resource-dashboard" "apps/resource-dashboard"
  ensure_build_config "workload-simulator" "apps/workload-simulator"
}

# ---------------------------------------------------------------------------
# 3. Build images
# ---------------------------------------------------------------------------
build_image() {
  local app="$1"
  local dir="$2"
  log "Building $app from $dir..."
  oc start-build "$app" --from-dir="$REPO_ROOT/$dir" -n "$BUILD_NS" --follow
}

build_all() {
  log "--- Building images ---"
  build_image "stress-app"         "apps/stress-app"
  build_image "resource-dashboard" "apps/resource-dashboard"
  build_image "workload-simulator" "apps/workload-simulator"
}

# ---------------------------------------------------------------------------
# 4. Allow image pulling from demo-builds
# ---------------------------------------------------------------------------
allow_image_pull() {
  local ns="$1"
  log "Allowing $ns to pull images from $BUILD_NS..."
  oc policy add-role-to-group system:image-puller "system:serviceaccounts:$ns" -n "$BUILD_NS" 2>/dev/null || true
}

setup_image_pull() {
  log "--- Setting up image pull permissions ---"
  allow_image_pull "app-bom"
  allow_image_pull "app-ruim"
  allow_image_pull "demo-dashboard"
  allow_image_pull "vpa-demo"
}

# ---------------------------------------------------------------------------
# 5. Deploy stress-app to app-bom
# ---------------------------------------------------------------------------
deploy_app_bom() {
  local ns="app-bom"
  local image="$REGISTRY/$BUILD_NS/stress-app:latest"
  log "--- Deploying stress-app to $ns (Boas Praticas) ---"

  if oc get deployment stress-app -n "$ns" > /dev/null 2>&1; then
    log "Deployment already exists, restarting..."
    oc rollout restart deployment/stress-app -n "$ns"
  else
    log "Creating deployment..."
    oc create deployment stress-app --image="$image" -n "$ns"

    oc set resources deployment/stress-app -n "$ns" \
      --requests="cpu=50m,memory=128Mi" \
      --limits="cpu=200m,memory=256Mi"

    oc set env deployment/stress-app -n "$ns" \
      NAMESPACE- \
      PEER_SERVICE="stress-app.app-ruim.svc.cluster.local:8080"

    oc set env deployment/stress-app -n "$ns" --from=fieldref:NAMESPACE=metadata.namespace

    oc expose deployment/stress-app --port=8080 -n "$ns" 2>/dev/null || true
    oc expose service/stress-app -n "$ns" 2>/dev/null || true
  fi

  # HPA
  if ! oc get hpa stress-app -n "$ns" > /dev/null 2>&1; then
    log "Creating HPA for $ns..."
    oc autoscale deployment/stress-app -n "$ns" \
      --min=1 --max=7 --cpu-percent=70
  fi
}

# ---------------------------------------------------------------------------
# 6. Deploy stress-app to app-ruim
# ---------------------------------------------------------------------------
deploy_app_ruim() {
  local ns="app-ruim"
  local image="$REGISTRY/$BUILD_NS/stress-app:latest"
  log "--- Deploying stress-app to $ns (Anti-pattern) ---"

  if oc get deployment stress-app -n "$ns" > /dev/null 2>&1; then
    log "Deployment already exists, restarting..."
    oc rollout restart deployment/stress-app -n "$ns"
  else
    log "Creating deployment..."
    oc create deployment stress-app --image="$image" -n "$ns"

    oc set resources deployment/stress-app -n "$ns" \
      --requests="cpu=2,memory=2Gi" \
      --limits="cpu=2,memory=2Gi"

    oc set env deployment/stress-app -n "$ns" \
      NAMESPACE- \
      PEER_ROUTE="stress-app-app-bom.$CLUSTER_DOMAIN"

    oc set env deployment/stress-app -n "$ns" --from=fieldref:NAMESPACE=metadata.namespace

    oc expose deployment/stress-app --port=8080 -n "$ns" 2>/dev/null || true
    oc expose service/stress-app -n "$ns" 2>/dev/null || true
  fi

  # HPA
  if ! oc get hpa stress-app -n "$ns" > /dev/null 2>&1; then
    log "Creating HPA for $ns..."
    oc autoscale deployment/stress-app -n "$ns" \
      --min=1 --max=5 --cpu-percent=70
  fi
}

# ---------------------------------------------------------------------------
# 7. Deploy resource-dashboard
# ---------------------------------------------------------------------------
deploy_dashboard() {
  local ns="demo-dashboard"
  local image="$REGISTRY/$BUILD_NS/resource-dashboard:latest"
  log "--- Deploying resource-dashboard to $ns ---"

  # ServiceAccount
  if ! oc get sa resource-dashboard -n "$ns" > /dev/null 2>&1; then
    log "Creating ServiceAccount..."
    oc create sa resource-dashboard -n "$ns"
  fi

  # ClusterRole
  if ! oc get clusterrole resource-dashboard-reader > /dev/null 2>&1; then
    log "Creating ClusterRole..."
    cat <<'EOCR' | oc apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: resource-dashboard-reader
rules:
- apiGroups: [""]
  resources: ["pods", "namespaces"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["metrics.k8s.io"]
  resources: ["pods", "nodes"]
  verbs: ["get", "list"]
EOCR
  fi

  # ClusterRoleBinding
  if ! oc get clusterrolebinding resource-dashboard-reader-binding > /dev/null 2>&1; then
    log "Creating ClusterRoleBinding..."
    cat <<EOCRB | oc apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: resource-dashboard-reader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: resource-dashboard-reader
subjects:
- kind: ServiceAccount
  name: resource-dashboard
  namespace: $ns
EOCRB
  fi

  if oc get deployment resource-dashboard -n "$ns" > /dev/null 2>&1; then
    log "Deployment already exists, restarting..."
    oc rollout restart deployment/resource-dashboard -n "$ns"
  else
    log "Creating deployment..."
    oc create deployment resource-dashboard --image="$image" -n "$ns"

    oc set resources deployment/resource-dashboard -n "$ns" \
      --requests="cpu=50m,memory=128Mi" \
      --limits="cpu=200m,memory=256Mi"

    oc set env deployment/resource-dashboard -n "$ns" \
      WATCH_NAMESPACES="app-ruim,app-bom"

    oc set serviceaccount deployment/resource-dashboard resource-dashboard -n "$ns"

    oc expose deployment/resource-dashboard --port=8080 -n "$ns" 2>/dev/null || true
    oc expose service/resource-dashboard -n "$ns" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# 8. Deploy workload-simulator to vpa-demo
# ---------------------------------------------------------------------------
deploy_workload_simulator() {
  local ns="vpa-demo"
  local image="$REGISTRY/$BUILD_NS/workload-simulator:latest"
  log "--- Deploying workload-simulator to $ns ---"

  if oc get deployment workload-simulator -n "$ns" > /dev/null 2>&1; then
    log "Deployment already exists, restarting..."
    oc rollout restart deployment/workload-simulator -n "$ns"
  else
    log "Creating deployment..."
    oc create deployment workload-simulator --image="$image" -n "$ns"

    oc set resources deployment/workload-simulator -n "$ns" \
      --requests="cpu=1,memory=1Gi" \
      --limits="cpu=1,memory=1Gi"

    oc expose deployment/workload-simulator --port=8080 -n "$ns" 2>/dev/null || true
    oc expose service/workload-simulator -n "$ns" 2>/dev/null || true
  fi

  # VPA
  if ! oc get vpa vpa-workload-simulator -n "$ns" > /dev/null 2>&1; then
    log "Creating VPA..."
    cat <<'EOVPA' | oc apply -n "$ns" -f -
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: vpa-workload-simulator
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: workload-simulator
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
    - containerName: workload-simulator
      controlledResources: ["cpu", "memory"]
EOVPA
  fi
}

# ---------------------------------------------------------------------------
# 9. Print summary
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "============================================================"
  log "Deployment complete!"
  echo "============================================================"
  echo ""
  echo "  App Bom (Boas Praticas):"
  echo "    https://stress-app-app-bom.$CLUSTER_DOMAIN"
  echo ""
  echo "  App Ruim (Anti-pattern):"
  echo "    https://stress-app-app-ruim.$CLUSTER_DOMAIN"
  echo ""
  echo "  Resource Dashboard:"
  echo "    https://resource-dashboard-demo-dashboard.$CLUSTER_DOMAIN"
  echo ""
  echo "  Workload Simulator:"
  echo "    https://workload-simulator-vpa-demo.$CLUSTER_DOMAIN"
  echo ""
  echo "============================================================"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo ""
  echo "============================================================"
  echo "  Workshop Apps - Manual Deploy"
  echo "============================================================"
  echo ""

  check_login
  detect_cluster_domain
  create_projects
  create_build_configs
  build_all
  setup_image_pull
  deploy_app_bom
  deploy_app_ruim
  deploy_dashboard
  deploy_workload_simulator
  print_summary
}

main "$@"
