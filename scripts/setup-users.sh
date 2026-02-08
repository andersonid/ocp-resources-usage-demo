#!/bin/bash
# ----------------------------------------------------------------------------
# setup-users.sh - Create HTPasswd users on OpenShift
#
# Usage:
#   ./scripts/setup-users.sh                           # interactive mode
#   ./scripts/setup-users.sh 2 48 energisa2026         # 2 admins, 48 devs, shared password
#   ./scripts/setup-users.sh 2 48 random               # 2 admins, 48 devs, random passwords
#
# Users are numbered sequentially: user01, user02, ... userN
# First N are cluster-admin, the rest are developers (self-provisioner).
# ----------------------------------------------------------------------------
set -e

HTPASSWD_FILE="/tmp/workshop-htpasswd"
CREDENTIALS_FILE="./workshop-credentials.csv"
SECRET_NAME="htpasswd-secret"
OAUTH_NS="openshift-config"

# -- Pre-flight ---------------------------------------------------------------
oc whoami > /dev/null 2>&1 || { echo "ERROR: Not logged in. Run 'oc login' first."; exit 1; }
command -v htpasswd > /dev/null 2>&1 || { echo "ERROR: htpasswd not found. Install httpd-tools."; exit 1; }

# -- Parse arguments or prompt ------------------------------------------------
NUM_ADMINS="${1:-}"
NUM_DEVS="${2:-}"
PASSWORD_MODE="${3:-}"

if [ -z "$NUM_ADMINS" ]; then
  read -rp "How many cluster-admin users? (e.g. 2): " NUM_ADMINS
fi

if ! [[ "$NUM_ADMINS" =~ ^[0-9]+$ ]] || [ "$NUM_ADMINS" -lt 1 ]; then
  echo "ERROR: Invalid number of admins: $NUM_ADMINS"
  exit 1
fi

if [ -z "$NUM_DEVS" ]; then
  read -rp "How many developer users? (e.g. 48): " NUM_DEVS
fi

if ! [[ "$NUM_DEVS" =~ ^[0-9]+$ ]] || [ "$NUM_DEVS" -lt 0 ]; then
  echo "ERROR: Invalid number of developers: $NUM_DEVS"
  exit 1
fi

TOTAL_USERS=$((NUM_ADMINS + NUM_DEVS))

if [ "$TOTAL_USERS" -lt 1 ]; then
  echo "ERROR: Total users must be at least 1."
  exit 1
fi

if [ -z "$PASSWORD_MODE" ]; then
  echo ""
  echo "Password options:"
  echo "  1) Shared password (same for all users)"
  echo "  2) Random password (unique per user)"
  read -rp "Choose [1/2]: " CHOICE
  if [ "$CHOICE" = "2" ]; then
    PASSWORD_MODE="random"
  else
    read -rsp "Enter shared password: " PASSWORD_MODE
    echo ""
  fi
fi

# -- Summary before execution -------------------------------------------------
echo ""
echo "================================================================"
echo "  Cluster-admin users: user01 to user$(printf '%02d' "$NUM_ADMINS") ($NUM_ADMINS)"
echo "  Developer users:     user$(printf '%02d' $((NUM_ADMINS + 1))) to user$(printf '%02d' "$TOTAL_USERS") ($NUM_DEVS)"
echo "  Total:               $TOTAL_USERS users"
if [ "$PASSWORD_MODE" = "random" ]; then
  echo "  Password:            random (see credentials file)"
else
  echo "  Password:            shared (same for all)"
fi
echo "================================================================"
echo ""

# -- Generate htpasswd file ---------------------------------------------------
rm -f "$HTPASSWD_FILE"
rm -f "$CREDENTIALS_FILE"

echo "username,password,role" > "$CREDENTIALS_FILE"

echo "Generating $TOTAL_USERS users..."
for i in $(seq 1 "$TOTAL_USERS"); do
  USERNAME=$(printf "user%02d" "$i")

  if [ "$PASSWORD_MODE" = "random" ]; then
    USER_PASS=$(openssl rand -base64 12 | tr -d '=/+' | head -c 12)
  else
    USER_PASS="$PASSWORD_MODE"
  fi

  if [ -f "$HTPASSWD_FILE" ]; then
    htpasswd -bB "$HTPASSWD_FILE" "$USERNAME" "$USER_PASS" 2>/dev/null
  else
    htpasswd -cbB "$HTPASSWD_FILE" "$USERNAME" "$USER_PASS" 2>/dev/null
  fi

  if [ "$i" -le "$NUM_ADMINS" ]; then
    ROLE="cluster-admin"
  else
    ROLE="developer"
  fi

  echo "${USERNAME},${USER_PASS},${ROLE}" >> "$CREDENTIALS_FILE"
done

echo "  HTPasswd file: $HTPASSWD_FILE"
echo "  Credentials:   $CREDENTIALS_FILE"

# -- Create/Update Secret ------------------------------------------------------
echo ""
echo "Creating Secret '$SECRET_NAME' in namespace '$OAUTH_NS'..."
oc create secret generic "$SECRET_NAME" \
  --from-file=htpasswd="$HTPASSWD_FILE" \
  -n "$OAUTH_NS" \
  --dry-run=client -o yaml | oc apply -f -

# -- Patch OAuth CR ------------------------------------------------------------
echo "Configuring OAuth identity provider (htpasswd_provider)..."
oc patch oauth cluster --type=merge -p '{
  "spec": {
    "identityProviders": [
      {
        "name": "htpasswd_provider",
        "type": "HTPasswd",
        "mappingMethod": "claim",
        "htpasswd": {
          "fileData": {
            "name": "'"$SECRET_NAME"'"
          }
        }
      }
    ]
  }
}'

# -- Wait for oauth pods to restart -------------------------------------------
echo ""
echo "Waiting for OAuth pods to restart (this may take up to 60s)..."
sleep 10
oc rollout status deployment/oauth-openshift -n openshift-authentication --timeout=120s 2>/dev/null || \
  echo "  OAuth pods are restarting. It may take a moment for logins to work."

# -- Create cluster-admins group and assign roles ------------------------------
echo ""
echo "Creating cluster-admins group..."
ADMIN_LIST=""
for i in $(seq 1 "$NUM_ADMINS"); do
  ADMIN_LIST="$ADMIN_LIST $(printf 'user%02d' "$i")"
done

oc adm groups new cluster-admins $ADMIN_LIST 2>/dev/null || \
  oc adm groups sync cluster-admins --confirm 2>/dev/null || true

# Ensure group exists and has the right members
oc get group cluster-admins > /dev/null 2>&1 || oc adm groups new cluster-admins
for i in $(seq 1 "$NUM_ADMINS"); do
  USERNAME=$(printf "user%02d" "$i")
  oc adm groups add-users cluster-admins "$USERNAME" 2>/dev/null || true
  oc adm policy add-cluster-role-to-user cluster-admin "$USERNAME" 2>/dev/null
  echo "  $USERNAME -> cluster-admin + cluster-admins group"
done

# -- Final summary -------------------------------------------------------------
LAST_ADMIN=$(printf "user%02d" "$NUM_ADMINS")
FIRST_DEV=$(printf "user%02d" $((NUM_ADMINS + 1)))
LAST_USER=$(printf "user%02d" "$TOTAL_USERS")

echo ""
echo "================================================================"
echo "  Setup complete!"
echo "  Admins:      user01 to $LAST_ADMIN ($NUM_ADMINS users)"
if [ "$NUM_DEVS" -gt 0 ]; then
echo "  Developers:  $FIRST_DEV to $LAST_USER ($NUM_DEVS users)"
fi
echo "  Credentials: $CREDENTIALS_FILE"
echo ""
echo "  Developers have self-provisioner role (can create projects)."
echo "  Admins have cluster-admin role."
echo "================================================================"

# Cleanup temp file
rm -f "$HTPASSWD_FILE"
