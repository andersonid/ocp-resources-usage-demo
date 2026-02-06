const express = require('express');
const k8s = require('@kubernetes/client-node');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Namespaces to monitor
const NAMESPACES = (process.env.WATCH_NAMESPACES || 'app-ruim,app-bom').split(',');

// K8s client setup
const kc = new k8s.KubeConfig();
kc.loadFromDefault(); // Uses in-cluster config or ~/.kube/config

const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
const metricsApi = new k8s.Metrics(kc);

// Serve static frontend
// In container: /app/server.js and /app/frontend/
// In dev: backend/server.js and frontend/
const frontendPath = path.join(__dirname, 'frontend');
const altFrontendPath = path.join(__dirname, '..', 'frontend');
const fs = require('fs');
const staticPath = fs.existsSync(frontendPath) ? frontendPath : altFrontendPath;
app.use(express.static(staticPath));

// --- Helper: parse CPU string to millicores ---
function parseCPU(cpuStr) {
  if (!cpuStr) return 0;
  cpuStr = String(cpuStr);
  if (cpuStr.endsWith('m')) return parseInt(cpuStr);
  if (cpuStr.endsWith('n')) return parseInt(cpuStr) / 1000000;
  return parseFloat(cpuStr) * 1000;
}

// --- Helper: parse Memory string to MiB ---
function parseMemory(memStr) {
  if (!memStr) return 0;
  memStr = String(memStr);
  if (memStr.endsWith('Ki')) return parseInt(memStr) / 1024;
  if (memStr.endsWith('Mi')) return parseInt(memStr);
  if (memStr.endsWith('Gi')) return parseInt(memStr) * 1024;
  if (memStr.endsWith('Ti')) return parseInt(memStr) * 1024 * 1024;
  if (memStr.endsWith('k')) return parseInt(memStr) / 1024;
  if (memStr.endsWith('M')) return parseInt(memStr);
  if (memStr.endsWith('G')) return parseInt(memStr) * 1024;
  // Plain bytes
  return parseInt(memStr) / (1024 * 1024);
}

// --- API: Get data for all watched namespaces ---
app.get('/api/namespaces', async (req, res) => {
  try {
    const results = await Promise.all(NAMESPACES.map(ns => getNamespaceData(ns)));
    res.json(results);
  } catch (err) {
    console.error('Erro ao buscar dados dos namespaces:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API: Get data for a single namespace ---
async function getNamespaceData(namespace) {
  const ns = namespace.trim();

  // Fetch pods, HPAs, and metrics in parallel
  const [podsRes, hpaRes, podMetrics] = await Promise.all([
    coreApi.listNamespacedPod({ namespace: ns }),
    autoscalingApi.listNamespacedHorizontalPodAutoscaler({ namespace: ns }).catch(() => ({ items: [] })),
    metricsApi.getPodMetrics(ns).catch(() => ({ items: [] }))
  ]);

  const pods = podsRes.items || [];
  const hpas = hpaRes.items || [];
  const metrics = podMetrics.items || [];

  // Build metrics lookup by pod name
  const metricsMap = {};
  for (const m of metrics) {
    const podName = m.metadata.name;
    let cpuTotal = 0;
    let memTotal = 0;
    for (const c of (m.containers || [])) {
      cpuTotal += parseCPU(c.usage?.cpu);
      memTotal += parseMemory(c.usage?.memory);
    }
    metricsMap[podName] = { cpu_millicores: Math.round(cpuTotal), memory_mib: Math.round(memTotal) };
  }

  // Build pod data
  const podData = pods.map(pod => {
    const containers = pod.spec.containers || [];
    let reqCPU = 0, reqMem = 0, limCPU = 0, limMem = 0;
    for (const c of containers) {
      reqCPU += parseCPU(c.resources?.requests?.cpu);
      reqMem += parseMemory(c.resources?.requests?.memory);
      limCPU += parseCPU(c.resources?.limits?.cpu);
      limMem += parseMemory(c.resources?.limits?.memory);
    }

    const usage = metricsMap[pod.metadata.name] || { cpu_millicores: 0, memory_mib: 0 };
    const ready = pod.status?.conditions?.find(c => c.type === 'Ready');

    return {
      name: pod.metadata.name,
      status: pod.status?.phase,
      ready: ready?.status === 'True',
      requests: { cpu_millicores: Math.round(reqCPU), memory_mib: Math.round(reqMem) },
      limits: { cpu_millicores: Math.round(limCPU), memory_mib: Math.round(limMem) },
      usage: usage
    };
  });

  // HPA data
  const hpaData = hpas.map(h => {
    const cpuMetric = h.status?.currentMetrics?.find(
      m => m.type === 'Resource' && m.resource?.name === 'cpu'
    );
    const cpuTarget = h.spec?.metrics?.find(
      m => m.type === 'Resource' && m.resource?.name === 'cpu'
    );

    return {
      name: h.metadata.name,
      minReplicas: h.spec.minReplicas,
      maxReplicas: h.spec.maxReplicas,
      currentReplicas: h.status?.currentReplicas || 0,
      desiredReplicas: h.status?.desiredReplicas || 0,
      currentCPUPercent: cpuMetric?.resource?.current?.averageUtilization ?? null,
      targetCPUPercent: cpuTarget?.resource?.target?.averageUtilization ?? null,
      conditions: (h.status?.conditions || []).map(c => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        message: c.message
      }))
    };
  });

  // Totals
  const totals = podData.reduce((acc, p) => ({
    reqCPU: acc.reqCPU + p.requests.cpu_millicores,
    reqMem: acc.reqMem + p.requests.memory_mib,
    limCPU: acc.limCPU + p.limits.cpu_millicores,
    limMem: acc.limMem + p.limits.memory_mib,
    usageCPU: acc.usageCPU + p.usage.cpu_millicores,
    usageMem: acc.usageMem + p.usage.memory_mib
  }), { reqCPU: 0, reqMem: 0, limCPU: 0, limMem: 0, usageCPU: 0, usageMem: 0 });

  const requestsEqualsLimits = podData.length > 0 && podData.every(
    p => p.requests.cpu_millicores === p.limits.cpu_millicores &&
         p.requests.memory_mib === p.limits.memory_mib
  );

  return {
    namespace: ns,
    label: ns === 'app-ruim' ? 'Praticas Ruins' : ns === 'app-bom' ? 'Boas Praticas' : ns,
    podCount: podData.length,
    pods: podData,
    hpa: hpaData,
    totals: {
      requests: { cpu_millicores: totals.reqCPU, memory_mib: totals.reqMem },
      limits: { cpu_millicores: totals.limCPU, memory_mib: totals.limMem },
      usage: { cpu_millicores: totals.usageCPU, memory_mib: totals.usageMem }
    },
    antiPatterns: {
      requestsEqualsLimits,
      cpuWastePercent: totals.reqCPU > 0
        ? Math.round((1 - totals.usageCPU / totals.reqCPU) * 100)
        : 0,
      memWastePercent: totals.reqMem > 0
        ? Math.round((1 - totals.usageMem / totals.reqMem) * 100)
        : 0
    }
  };
}

// --- Health ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Resource Dashboard rodando na porta ${PORT}`);
  console.log(`Monitorando namespaces: ${NAMESPACES.join(', ')}`);
});
