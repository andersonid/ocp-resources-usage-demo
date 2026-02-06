# OCP Resources Usage Demo

Demo applications for an OpenShift workshop focused on resource management best practices: Requests, Limits, QoS Classes, Scheduler behavior, and Horizontal Pod Autoscaler (HPA).

## Overview

This project contains two demo applications and a monitoring dashboard to visually demonstrate the impact of correct vs incorrect resource configuration in OpenShift/Kubernetes.

### Applications

- **stress-app** - A Node.js application that generates CPU and memory load on demand. Deployed in two namespaces with different resource configurations to compare behaviors.
- **resource-dashboard** - A real-time dashboard that reads Kubernetes Metrics API data and displays resource usage, HPA status, and anti-pattern detection for both namespaces side by side.

### Namespaces

| Namespace | Purpose | CPU Request | CPU Limit | Mem Request | Mem Limit | QoS Class |
|-----------|---------|-------------|-----------|-------------|-----------|-----------|
| app-ruim  | Anti-pattern demo | 2000m | 2000m | 2Gi | 2Gi | Guaranteed |
| app-bom   | Best practices demo | 50m | 200m | 128Mi | 256Mi | Burstable |

## Key Concepts Demonstrated

1. **Requests vs Limits** - How requests reserve resources on the scheduler and limits enforce ceilings at runtime
2. **QoS Classes** - Guaranteed (requests = limits) vs Burstable (requests < limits)
3. **HPA behavior** - Why inflated requests prevent the HPA from scaling (percentage = usage / request)
4. **OOMKill** - What happens when a container exceeds its memory limit
5. **Resource waste** - Visual comparison of reserved vs actually used resources

## Prerequisites

- OpenShift 4.x cluster
- `oc` CLI authenticated with cluster-admin or equivalent
- Metrics Server available (default in OpenShift)

## Deployment

### 1. Create projects

```bash
oc new-project app-ruim --display-name="Praticas Ruins"
oc new-project app-bom --display-name="Boas Praticas"
oc new-project demo-builds --display-name="Builds"
oc new-project demo-dashboard --display-name="Dashboard"
```

### 2. Build images

```bash
oc new-build --name=stress-app --binary --strategy=docker -n demo-builds
oc start-build stress-app --from-dir=apps/stress-app -n demo-builds --follow

oc new-build --name=resource-dashboard --binary --strategy=docker -n demo-builds
oc start-build resource-dashboard --from-dir=apps/resource-dashboard -n demo-builds --follow
```

### 3. Allow image pulling across namespaces

```bash
oc policy add-role-to-user system:image-puller system:serviceaccount:app-ruim:default -n demo-builds
oc policy add-role-to-user system:image-puller system:serviceaccount:app-bom:default -n demo-builds
oc policy add-role-to-user system:image-puller system:serviceaccount:demo-dashboard:default -n demo-builds
```

### 4. Deploy manifests

```bash
oc apply -f manifests/app-ruim/
oc apply -f manifests/app-bom/
oc apply -f manifests/dashboard/
```

### 5. Dashboard RBAC

The dashboard needs read access to metrics across namespaces:

```bash
oc adm policy add-cluster-role-to-user view system:serviceaccount:demo-dashboard:dashboard-sa
```

## Customization

- Replace `apps/stress-app/logo.png` and `apps/resource-dashboard/frontend/logo.png` with your own logo
- Adjust resource values in `manifests/app-ruim/deployment.yaml` and `manifests/app-bom/deployment.yaml`
- Configure watched namespaces via the `WATCH_NAMESPACES` environment variable in `manifests/dashboard/deployment.yaml`

## Project Structure

```
.
├── apps/
│   ├── stress-app/          # CPU/memory load generator
│   │   ├── Dockerfile
│   │   ├── server.js
│   │   ├── package.json
│   │   └── logo.png
│   └── resource-dashboard/  # Real-time monitoring dashboard
│       ├── Dockerfile
│       ├── backend/
│       │   ├── server.js
│       │   └── package.json
│       └── frontend/
│           ├── index.html
│           ├── app.js
│           ├── styles.css
│           └── logo.png
└── manifests/
    ├── app-ruim/             # Anti-pattern deployment
    ├── app-bom/              # Best practices deployment
    └── dashboard/            # Monitoring dashboard deployment
```

## License

MIT
