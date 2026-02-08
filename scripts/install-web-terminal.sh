#!/bin/bash
# ----------------------------------------------------------------------------
# install-web-terminal.sh - Install Web Terminal Operator on OpenShift
# Usage: ./scripts/install-web-terminal.sh
# ----------------------------------------------------------------------------
set -e

echo "Installing Web Terminal Operator..."

oc whoami > /dev/null 2>&1 || { echo "ERROR: Not logged in. Run 'oc login' first."; exit 1; }

# Create Subscription for Web Terminal Operator
cat <<'EOF' | oc apply -f -
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: web-terminal
  namespace: openshift-operators
spec:
  channel: fast
  installPlanApproval: Automatic
  name: web-terminal
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF

echo "Waiting for operator to install..."
sleep 15

# Check if operator is ready
for i in $(seq 1 20); do
  STATUS=$(oc get csv -n openshift-operators -l operators.coreos.com/web-terminal.openshift-operators -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Pending")
  if [ "$STATUS" = "Succeeded" ]; then
    echo "Web Terminal Operator installed successfully."
    echo ""
    echo "Access it via the >_ icon in the top-right of the OpenShift Console."
    exit 0
  fi
  echo "  Status: $STATUS (attempt $i/20)..."
  sleep 10
done

echo "Operator installation is still in progress. Check the OpenShift Console for status."
echo "  oc get csv -n openshift-operators | grep web-terminal"
