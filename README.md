# OCP Resources Usage Demo

Demo applications for an OpenShift workshop focused on resource management best practices: Requests, Limits, QoS Classes, Scheduler behavior, HPA, VPA, and GitOps-driven deployment.

## Overview

This project contains three demo applications and a monitoring dashboard to visually demonstrate the impact of correct vs incorrect resource configuration in OpenShift/Kubernetes. It uses OpenShift Pipelines (Tekton) for CI and OpenShift GitOps (Argo CD) for CD.

### Applications

| Application | Description |
|-------------|-------------|
| **stress-app** | Node.js app that generates CPU and memory load on demand. Deployed in two namespaces with different resource configurations. |
| **resource-dashboard** | Real-time dashboard consuming Kubernetes Metrics API. Displays resource usage, HPA status, and anti-pattern detection side by side. |
| **workload-simulator** | Simulates realistic workload patterns (peak/off-peak cycles) for VPA recommendation collection. |
| **workshop-slides** | Interactive slide deck (reveal.js) with presenter/follower sync and speaker notes support. |

### Namespaces

| Namespace | Purpose | CPU Request | CPU Limit | Mem Request | Mem Limit | QoS Class |
|-----------|---------|-------------|-----------|-------------|-----------|-----------|
| app-bom | Best practices | 50m | 200m | 128Mi | 256Mi | Burstable |
| app-ruim | Anti-pattern | 2000m | 2000m | 2Gi | 2Gi | Guaranteed |
| demo-dashboard | Monitoring dashboard | 50m | 200m | 128Mi | 256Mi | Burstable |
| demo-builds | Pipelines and image builds | - | - | - | - | - |
| vpa-demo | VPA demonstration | 1000m | 1000m | 1Gi | 1Gi | Guaranteed |

## Architecture

```
GitHub Repository
  |
  |-- push to apps/        --> GitHub Webhook --> Tekton Pipeline (CI)
  |                                                  |
  |                                                  v
  |                                            Build image (buildah)
  |                                                  |
  |                                                  v
  |                                            Push to internal registry
  |
  |-- push to gitops/      --> Argo CD detects change (CD)
                                                     |
                                                     v
                                               Sync manifests to cluster
                                               (Deployments, Services,
                                                Routes, HPA, VPA, RBAC)
```

## Workshop Slides (Presenter / Follower mode)

The `workshop-slides` application includes a real-time synchronization feature using Socket.io. This allows a presenter (e.g., on a tablet) to control the slide navigation for all connected followers (e.g., projected on a screen).

| URL | Description |
|-----|-------------|
| `/` | Normal independent navigation (default) |
| `/?presenter` | Presenter mode -- controls slides for all followers. Press **S** to open Speaker Notes. |
| `/?follow` | Follower mode -- keyboard, touch, and controls are disabled. Slides sync automatically with the presenter. |

Usage:

1. Open `/?presenter` on the device you will use to control the presentation (e.g., tablet).
2. Open `/?follow` on the device connected to the projector or shared screen.
3. Navigate slides on the presenter device; the follower will mirror the navigation in real time.
4. Press **S** on the presenter window to open Speaker Notes (does not affect follower sync).

## Key Concepts Demonstrated

1. **Requests vs Limits** - How requests reserve resources on the scheduler and limits enforce ceilings at runtime
2. **QoS Classes** - Guaranteed (requests = limits) vs Burstable (requests < limits)
3. **HPA behavior** - Why inflated requests prevent the HPA from scaling (percentage = usage / request)
4. **VPA recommendations** - Using Vertical Pod Autoscaler in Off mode for right-sizing
5. **OOMKill** - What happens when a container exceeds its memory limit
6. **Resource waste** - Visual comparison of reserved vs actually used resources
7. **Route vs Service** - Anti-pattern of using external routes for internal pod-to-pod communication
8. **CI/CD separation** - Pipeline builds images (CI), GitOps deploys manifests (CD)
9. **GitOps with Argo CD** - Git as the single source of truth, with auto-sync and self-heal

## Prerequisites

- OpenShift 4.x cluster
- `oc` CLI authenticated with cluster-admin
- Operators installed:
  - Red Hat OpenShift Pipelines
  - Red Hat OpenShift GitOps
  - Vertical Pod Autoscaler (for VPA demo)
- Metrics Server available (default in OpenShift)

## Deployment

### Option A: GitOps (recommended)

#### 1. Create projects

```bash
oc new-project demo-builds    --display-name="Demo - Builds"
oc new-project app-bom        --display-name="App Bom - Boas Praticas"
oc new-project app-ruim       --display-name="App Ruim - Anti-pattern"
oc new-project demo-dashboard --display-name="Demo - Dashboard"
oc new-project vpa-demo       --display-name="VPA Demo - Workload Simulator"
```

#### 2. Setup image pull permissions

```bash
for ns in app-bom app-ruim demo-dashboard vpa-demo; do
  oc policy add-role-to-group system:image-puller "system:serviceaccounts:$ns" -n demo-builds
done
```

#### 3. Apply Pipeline resources

```bash
oc apply -f pipelines/
```

#### 4. Build images (first time)

Run a PipelineRun for each app, or trigger via GitHub push:

```bash
# Manual trigger example for stress-app
cat <<EOF | oc create -n demo-builds -f -
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: stress-app-run-
spec:
  pipelineRef:
    name: build-and-push
  params:
    - name: APP_NAME
      value: stress-app
    - name: APP_PATH
      value: apps/stress-app
    - name: IMAGE
      value: image-registry.openshift-image-registry.svc:5000/demo-builds/stress-app:latest
  workspaces:
    - name: source
      persistentVolumeClaim:
        claimName: pipeline-workspace
EOF
```

Repeat for `resource-dashboard` and `workload-simulator` (change APP_NAME, APP_PATH, and IMAGE accordingly).

#### 5. Deploy via Argo CD

```bash
oc apply -f gitops/argocd/
```

Argo CD will sync all manifests from `gitops/` to the cluster automatically.

### Option B: Manual fallback

If Pipelines/GitOps are not available, use the manual deploy script:

```bash
./scripts/deploy-manual.sh
```

### Cleanup

Remove all workshop resources:

```bash
./scripts/cleanup-all.sh
```

## GitHub Webhook (CI automation)

The EventListener is exposed via Route. Configure a webhook in your GitHub repository:

- **Payload URL**: `https://<github-webhook-route>/`
- **Content type**: `application/json`
- **Events**: Just the push event

The pipeline uses CEL interceptors to detect which app was modified and triggers the corresponding build only.

## Project Structure

```
.
├── apps/
│   ├── stress-app/              # CPU/memory load generator
│   ├── resource-dashboard/      # Real-time monitoring dashboard
│   ├── workload-simulator/      # Workload pattern simulator for VPA
│   └── workshop-slides/         # Interactive slide deck with presenter sync
├── gitops/
│   ├── app-bom/                 # Manifests: Deployment, Service, Route, HPA
│   ├── app-ruim/                # Manifests: Deployment, Service, Route, HPA
│   ├── demo-dashboard/          # Manifests: Deployment, Service, Route, RBAC
│   ├── vpa-demo/                # Manifests: Deployment, Service, Route, VPA
│   └── argocd/                  # Argo CD Application definitions
├── pipelines/
│   ├── 01-pipeline.yaml         # Generic build-and-push Pipeline
│   ├── 02-pvc.yaml              # Shared workspace PVC
│   ├── 03-trigger.yaml          # TriggerBindings, TriggerTemplates, EventListener
│   └── 04-trigger-route.yaml    # Route for GitHub webhook
├── scripts/
│   ├── deploy-manual.sh         # Fallback: manual deploy via oc commands
│   └── cleanup-all.sh           # Remove all workshop resources
└── docs/                        # Workshop documentation (not in this repo)
```

## Customization

- Replace `apps/*/logo.png` with your own logo
- Adjust resource values in `gitops/app-ruim/deployment.yaml` and `gitops/app-bom/deployment.yaml`
- Configure watched namespaces via `WATCH_NAMESPACES` env var in `gitops/demo-dashboard/deployment.yaml`
- Modify HPA thresholds in `gitops/app-bom/hpa.yaml` and `gitops/app-ruim/hpa.yaml`
- Change VPA mode in `gitops/vpa-demo/vpa.yaml`

## License

MIT
