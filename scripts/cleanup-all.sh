#!/bin/bash
# =============================================================================
# Cleanup Script - Remove all workshop projects and cluster-scoped resources
# Run from anywhere: ./scripts/cleanup-all.sh
# =============================================================================

set -e

oc whoami > /dev/null 2>&1 || { echo "ERROR: Not logged in. Run 'oc login' first."; exit 1; }

echo "Deleting projects..."
oc delete project app-bom app-ruim demo-builds demo-dashboard vpa-demo --ignore-not-found --wait=false

echo "Deleting cluster-scoped resources..."
oc delete clusterrolebinding resource-dashboard-reader-binding --ignore-not-found
oc delete clusterrole resource-dashboard-reader --ignore-not-found

echo "Done. Projects will terminate in background."
