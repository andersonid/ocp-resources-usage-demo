const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const POD_NAME = process.env.HOSTNAME || 'desconhecido';
const NAMESPACE = process.env.NAMESPACE || 'desconhecido';

// Target for cross-namespace communication test
const PEER_ROUTE = process.env.PEER_ROUTE || '';   // external Route URL
const PEER_SERVICE = process.env.PEER_SERVICE || ''; // internal Service DNS

// Detect memory limit from cgroups (works inside containers)
function getMemoryLimitMB() {
  const paths = [
    '/sys/fs/cgroup/memory.max',            // cgroups v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes' // cgroups v1
  ];
  for (const p of paths) {
    try {
      const val = fs.readFileSync(p, 'utf8').trim();
      if (val === 'max' || val === '9223372036854771712') return null; // no limit
      return Math.round(parseInt(val) / (1024 * 1024));
    } catch (e) { /* next */ }
  }
  return null;
}
const MEMORY_LIMIT_MB = getMemoryLimitMB();

// Serve static files (logo)
app.use(express.static(path.join(__dirname)));

// Track active stress operations
let cpuStressActive = false;
let memoryBlocks = [];

// --- Theme based on namespace ---
function getTheme() {
  if (NAMESPACE.includes('ruim')) {
    return {
      headerBg: '#b03a2e',
      headerBgHover: '#922b21',
      cardBorder: '#e74c3c',
      badge: 'Anti-pattern',
      badgeBg: '#fadbd8',
      badgeColor: '#b03a2e',
      label: 'Praticas Ruins'
    };
  }
  return {
    headerBg: '#1e8449',
    headerBgHover: '#196f3d',
    cardBorder: '#27ae60',
    badge: 'Recomendado',
    badgeBg: '#d5f5e3',
    badgeColor: '#1e8449',
    label: 'Boas Praticas'
  };
}

// --- YAML snippets for info popups ---
function getYamlSnippets() {
  const isRuim = NAMESPACE.includes('ruim');

  const resources = isRuim
    ? `<span class="yaml-comment"># deployment.yaml -- anti-pattern: requests = limits (QoS Guaranteed)</span>
<span class="yaml-comment"># Recursos superdimensionados, sem espaco para burst</span>
<span class="yaml-key">resources:</span>
  <span class="yaml-key">requests:</span>
    <span class="yaml-key">cpu:</span> <span class="yaml-bad">"2000m"</span>      <span class="yaml-comment"># 2 vCPUs reservados (provavelmente usa &lt;100m)</span>
    <span class="yaml-key">memory:</span> <span class="yaml-bad">"2Gi"</span>     <span class="yaml-comment"># 2 Gi reservados (provavelmente usa ~60Mi)</span>
  <span class="yaml-key">limits:</span>
    <span class="yaml-key">cpu:</span> <span class="yaml-bad">"2000m"</span>      <span class="yaml-comment"># = requests (sem burst permitido)</span>
    <span class="yaml-key">memory:</span> <span class="yaml-bad">"2Gi"</span>     <span class="yaml-comment"># = requests (QoS Guaranteed desnecessario)</span>`
    : `<span class="yaml-comment"># deployment.yaml -- recomendado: requests &lt; limits (QoS Burstable)</span>
<span class="yaml-comment"># Reserva o minimo, permite burst ate o limit</span>
<span class="yaml-key">resources:</span>
  <span class="yaml-key">requests:</span>
    <span class="yaml-key">cpu:</span> <span class="yaml-value">"50m"</span>        <span class="yaml-comment"># Reserva modesta baseada em uso real</span>
    <span class="yaml-key">memory:</span> <span class="yaml-value">"128Mi"</span>   <span class="yaml-comment"># Suficiente para operacao normal</span>
  <span class="yaml-key">limits:</span>
    <span class="yaml-key">cpu:</span> <span class="yaml-value">"200m"</span>       <span class="yaml-comment"># Permite burst ate 4x o request</span>
    <span class="yaml-key">memory:</span> <span class="yaml-value">"256Mi"</span>   <span class="yaml-comment"># Teto de seguranca (2x request)</span>`;

  const hpa = isRuim
    ? `<span class="yaml-comment"># hpa.yaml -- com requests superdimensionados, o HPA fica "travado"</span>
<span class="yaml-key">spec:</span>
  <span class="yaml-key">scaleTargetRef:</span>
    <span class="yaml-key">name:</span> <span class="yaml-value">stress-app</span>
  <span class="yaml-key">minReplicas:</span> <span class="yaml-value">1</span>
  <span class="yaml-key">maxReplicas:</span> <span class="yaml-value">5</span>
  <span class="yaml-key">metrics:</span>
  - <span class="yaml-key">type:</span> <span class="yaml-value">Resource</span>
    <span class="yaml-key">resource:</span>
      <span class="yaml-key">name:</span> <span class="yaml-value">cpu</span>
      <span class="yaml-key">target:</span>
        <span class="yaml-key">type:</span> <span class="yaml-value">Utilization</span>
        <span class="yaml-key">averageUtilization:</span> <span class="yaml-bad">70</span>  <span class="yaml-comment"># 70% de 2000m = 1400m (nunca atinge)</span>`
    : `<span class="yaml-comment"># hpa.yaml -- com requests corretos, o HPA reage rapidamente</span>
<span class="yaml-key">spec:</span>
  <span class="yaml-key">scaleTargetRef:</span>
    <span class="yaml-key">name:</span> <span class="yaml-value">stress-app</span>
  <span class="yaml-key">minReplicas:</span> <span class="yaml-value">1</span>
  <span class="yaml-key">maxReplicas:</span> <span class="yaml-value">5</span>
  <span class="yaml-key">metrics:</span>
  - <span class="yaml-key">type:</span> <span class="yaml-value">Resource</span>
    <span class="yaml-key">resource:</span>
      <span class="yaml-key">name:</span> <span class="yaml-value">cpu</span>
      <span class="yaml-key">target:</span>
        <span class="yaml-key">type:</span> <span class="yaml-value">Utilization</span>
        <span class="yaml-key">averageUtilization:</span> <span class="yaml-value">70</span>  <span class="yaml-comment"># 70% de 50m = 35m (escala com pouca carga)</span>`;

  const networking = isRuim
    ? `<span class="yaml-comment"># deployment.yaml -- anti-pattern: usa Route externa para comunicacao interna</span>
<span class="yaml-key">env:</span>
- <span class="yaml-key">name:</span> <span class="yaml-value">PEER_ROUTE</span>
  <span class="yaml-key">value:</span> <span class="yaml-bad">"stress-app-app-bom.apps.cluster-xxx.opentlc.com"</span>
<span class="yaml-comment"># Trafego sai do cluster, passa pelo Router/HAProxy,</span>
<span class="yaml-comment"># resolve DNS externo, negocia TLS, e volta.</span>
<span class="yaml-comment"># Resultado: ~20ms por chamada, carga no Router.</span>`
    : `<span class="yaml-comment"># deployment.yaml -- recomendado: usa Service DNS interno</span>
<span class="yaml-key">env:</span>
- <span class="yaml-key">name:</span> <span class="yaml-value">PEER_SERVICE</span>
  <span class="yaml-key">value:</span> <span class="yaml-value">"stress-app.app-ruim.svc.cluster.local:8080"</span>
<span class="yaml-comment"># Formato: &lt;service&gt;.&lt;namespace&gt;.svc.cluster.local:&lt;port&gt;</span>
<span class="yaml-comment"># Trafego fica 100% dentro do cluster via SDN.</span>
<span class="yaml-comment"># Resultado: ~5ms por chamada, sem carga no Router.</span>`;

  return { resources, hpa, networking };
}

// --- HTML UI ---
function buildHTML() {
  const memUsage = process.memoryUsage();
  const memAllocatedMB = memoryBlocks.reduce((sum, b) => sum + b.length, 0) / (1024 * 1024);
  const t = getTheme();
  const yaml = getYamlSnippets();

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stress App - ${NAMESPACE}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #F3F8FD; color: #003556; }
    .header { background: ${t.headerBg}; color: white; padding: 14px 28px; display: flex; align-items: center; gap: 16px; }
    .header-logo { height: 32px; background: white; padding: 4px 10px; border-radius: 6px; }
    .header .sep { width: 1px; height: 32px; background: rgba(255,255,255,0.25); }
    .header h1 { font-size: 1.3rem; font-weight: 400; }
    .header .pod-info { font-size: 0.78rem; opacity: 0.7; margin-left: auto; text-align: right; line-height: 1.4; }
    .container { max-width: 820px; margin: 24px auto; padding: 0 20px; }
    .ns-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
    .ns-label { font-size: 1rem; font-weight: 600; color: #003556; }
    .ns-badge { font-size: 0.72rem; padding: 3px 12px; border-radius: 12px; font-weight: 600;
                background: ${t.badgeBg}; color: ${t.badgeColor}; text-transform: uppercase; }
    .card { background: white; border-radius: 8px; padding: 22px 24px; margin-bottom: 18px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 4px solid ${t.cardBorder}; }
    .card h2 { font-size: 1.05rem; margin-bottom: 10px; color: ${t.headerBg}; }
    .card p { font-size: 0.88rem; color: #555; margin-bottom: 8px; }
    .btn { display: inline-block; padding: 10px 20px; border: none; border-radius: 6px;
           font-size: 0.88rem; cursor: pointer; color: white; margin: 4px; text-decoration: none;
           transition: background 0.2s; }
    .btn-stress { background: #FB8200; }
    .btn-stress:hover { background: #e07500; }
    .btn-release { background: #0072A6; }
    .btn-release:hover { background: #005f8c; }
    .btn-danger { background: #c0392b; }
    .btn-danger:hover { background: #a93226; }
    .status { padding: 12px 14px; background: #F3F8FD; border-radius: 6px; margin-top: 12px;
              font-family: 'Courier New', monospace; font-size: 0.83rem; line-height: 1.7; }
    .status .label { color: ${t.headerBg}; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.73rem;
             font-weight: 600; margin-left: 6px; }
    .badge-on { background: #FB8200; color: white; }
    .badge-off { background: #d5f5e3; color: #1e8449; }
    .mem-bar-container { margin-top: 14px; margin-bottom: 8px; }
    .mem-bar-label { display: flex; justify-content: space-between; font-size: 0.82rem; font-weight: 600; margin-bottom: 5px; color: #003556; }
    .mem-bar-pct { font-weight: 700; }
    .mem-bar-track { height: 22px; background: #e8eff5; border-radius: 11px; overflow: hidden; position: relative; }
    .mem-bar-fill { height: 100%; background: linear-gradient(90deg, #27ae60, #2ecc71); border-radius: 11px; transition: width 0.4s ease; min-width: 2%; }
    .mem-bar-fill.warning { background: linear-gradient(90deg, #f39c12, #e67e22); }
    .mem-bar-fill.danger { background: linear-gradient(90deg, #e74c3c, #c0392b); animation: pulse-danger 1s ease-in-out infinite; }
    @keyframes pulse-danger { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
    .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .card-header h2 { margin-bottom: 0; }
    .info-btn { width: 22px; height: 22px; border-radius: 50%; border: 2px solid ${t.headerBg}; background: transparent;
                color: ${t.headerBg}; font-size: 0.75rem; font-weight: 700; cursor: pointer; display: inline-flex;
                align-items: center; justify-content: center; font-style: italic; font-family: Georgia, serif;
                transition: all 0.2s; flex-shrink: 0; }
    .info-btn:hover { background: ${t.headerBg}; color: white; }
    .yaml-popup { display: none; background: #1e1e2e; color: #cdd6f4; border-radius: 8px; padding: 16px;
                  margin-top: 10px; font-family: 'Courier New', monospace; font-size: 0.78rem; line-height: 1.6;
                  overflow-x: auto; position: relative; white-space: pre; }
    .yaml-popup.visible { display: block; }
    .yaml-popup .yaml-title { color: #89b4fa; font-weight: 700; margin-bottom: 8px; font-family: 'Segoe UI', sans-serif; font-size: 0.82rem; }
    .yaml-popup .yaml-comment { color: #6c7086; }
    .yaml-popup .yaml-key { color: #89b4fa; }
    .yaml-popup .yaml-value { color: #a6e3a1; }
    .yaml-popup .yaml-bad { color: #f38ba8; }
    .yaml-popup .yaml-close { position: absolute; top: 8px; right: 12px; background: none; border: none;
                               color: #6c7086; cursor: pointer; font-size: 1rem; }
    .yaml-popup .yaml-close:hover { color: #cdd6f4; }
  </style>
</head>
<body>
  <div class="header">
    <img src="/logo.png" alt="Logo" class="header-logo">
    <div class="sep"></div>
    <h1>Stress App</h1>
    <div class="pod-info">
      Pod: ${POD_NAME}<br>Namespace: ${NAMESPACE}
    </div>
  </div>
  <div class="container">
    <div class="ns-bar">
      <span class="ns-label">${NAMESPACE}</span>
      <span class="ns-badge">${t.badge}</span>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Carga de CPU</h2>
        <button class="info-btn" onclick="toggleYaml('yamlResources')" title="Ver YAML">i</button>
      </div>
      <div class="yaml-popup" id="yamlResources">
        <button class="yaml-close" onclick="toggleYaml('yamlResources')">&times;</button>
        <div class="yaml-title">Configuracao de Resources (deployment.yaml)</div>
${yaml.resources}

<div class="yaml-title" style="margin-top: 12px;">Configuracao do HPA (hpa.yaml)</div>
${yaml.hpa}
      </div>
      <p>Gera consumo de CPU para demonstrar o comportamento do HPA.</p>
      <div style="margin-top: 12px;">
        <a class="btn btn-stress" href="/load?duration=60&intensity=1">60s - Leve</a>
        <a class="btn btn-stress" href="/load?duration=120&intensity=2">120s - Moderado</a>
        <a class="btn btn-danger" href="/load?duration=300&intensity=4">5min - Pesado</a>
      </div>
      <div class="status">
        <span class="label">Carga ativa:</span> ${cpuStressActive ? '<span class="badge badge-on">SIM</span>' : '<span class="badge badge-off">NAO</span>'}<br>
        <span class="label">Cores disponiveis:</span> ${os.cpus().length}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Alocacao de Memoria</h2>
        <button class="info-btn" onclick="toggleYaml('yamlMemory')" title="Ver YAML">i</button>
      </div>
      <div class="yaml-popup" id="yamlMemory">
        <button class="yaml-close" onclick="toggleYaml('yamlMemory')">&times;</button>
        <div class="yaml-title">Configuracao de Memory Limits (deployment.yaml)</div>
${yaml.resources}
      </div>
      <p>Aloca blocos de memoria para demonstrar os limits de memoria.</p>
      <div style="margin-top: 12px;">
        <a class="btn btn-stress" href="/allocate?size=64">+64 MB</a>
        <a class="btn btn-release" href="/release">Liberar Tudo</a>
      </div>
      ${MEMORY_LIMIT_MB ? `
      <div class="mem-bar-container">
        <div class="mem-bar-label">
          <span>Memoria: ${(memUsage.rss / 1024 / 1024).toFixed(0)} Mi / ${MEMORY_LIMIT_MB} Mi limit</span>
          <span class="mem-bar-pct">${Math.round((memUsage.rss / 1024 / 1024) / MEMORY_LIMIT_MB * 100)}%</span>
        </div>
        <div class="mem-bar-track">
          <div class="mem-bar-fill ${(memUsage.rss / 1024 / 1024) / MEMORY_LIMIT_MB > 0.8 ? 'danger' : (memUsage.rss / 1024 / 1024) / MEMORY_LIMIT_MB > 0.5 ? 'warning' : ''}" style="width: ${Math.min(Math.round((memUsage.rss / 1024 / 1024) / MEMORY_LIMIT_MB * 100), 100)}%"></div>
        </div>
        <div style="font-size: 0.72rem; color: #888; font-style: italic; margin-top: 4px;">Valor = RSS do processo. O Kubernetes usa working_set (pode ser menor).</div>
      </div>
      ` : ''}
      <div class="status">
        <span class="label">Blocos alocados:</span> ${memoryBlocks.length}<br>
        <span class="label">Total alocado:</span> ${memAllocatedMB.toFixed(1)} MB<br>
        <span class="label">RSS:</span> ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB${MEMORY_LIMIT_MB ? `<br>
        <span class="label">Memory Limit:</span> ${MEMORY_LIMIT_MB} MB` : ''}
      </div>
    </div>

    <div class="card">
      <h2>Informacoes do Pod</h2>
      <div class="status">
        <span class="label">Pod:</span> ${POD_NAME}<br>
        <span class="label">Namespace:</span> ${NAMESPACE}<br>
        <span class="label">Plataforma:</span> ${os.platform()} ${os.arch()}<br>
        <span class="label">Node.js:</span> ${process.version}<br>
        <span class="label">Uptime:</span> ${Math.floor(process.uptime())}s
      </div>
    </div>

    ${(PEER_ROUTE || PEER_SERVICE) ? `
    <div class="card">
      <div class="card-header">
        <h2>Teste de Comunicacao entre Namespaces</h2>
        <button class="info-btn" onclick="toggleYaml('yamlNet')" title="Ver YAML">i</button>
      </div>
      <div class="yaml-popup" id="yamlNet">
        <button class="yaml-close" onclick="toggleYaml('yamlNet')">&times;</button>
        <div class="yaml-title">Configuracao de comunicacao (deployment.yaml)</div>
${yaml.networking}
      </div>
      <p>Compara a latencia de chamar outro servico via <strong>Route</strong> (externa) vs <strong>Service</strong> (interna).</p>

      <div style="display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap;">
        ${PEER_ROUTE ? '<button class="btn btn-danger" onclick="runLatencyTest(\'route\')">Via Route (anti-pattern)</button>' : ''}
        ${PEER_SERVICE ? '<button class="btn btn-stress" onclick="runLatencyTest(\'service\')">Via Service (recomendado)</button>' : ''}
        ${(PEER_ROUTE && PEER_SERVICE) ? '<button class="btn btn-release" onclick="runComparison()">Comparar ambos</button>' : ''}
      </div>

      <div id="netResult" style="margin-top: 14px;"></div>

      <div id="hopDiagram" style="margin-top: 14px; display: none;">
        <div style="font-size: 0.82rem; font-weight: 600; margin-bottom: 8px; color: #003556;">Caminho da requisicao:</div>
        <div id="hopContent"></div>
      </div>
    </div>
    ` : ''}
  </div>

  <script>
    function toggleYaml(id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('visible');
    }

    async function runLatencyTest(mode) {
      const el = document.getElementById('netResult');
      el.innerHTML = '<div class="status"><span class="label">Executando 5 chamadas...</span></div>';
      try {
        const res = await fetch('/api/call-service?mode=' + mode + '&n=5');
        const d = await res.json();
        if (d.error) { el.innerHTML = '<div class="status" style="color:red;">' + d.error + '</div>'; return; }
        renderResult(el, [d]);
      } catch (e) { el.innerHTML = '<div class="status" style="color:red;">Erro: ' + e.message + '</div>'; }
    }

    async function runComparison() {
      const el = document.getElementById('netResult');
      el.innerHTML = '<div class="status"><span class="label">Executando comparacao (10 chamadas)...</span></div>';
      try {
        const [r1, r2] = await Promise.all([
          fetch('/api/call-service?mode=route&n=5').then(r => r.json()),
          fetch('/api/call-service?mode=service&n=5').then(r => r.json())
        ]);
        renderResult(el, [r1, r2]);
      } catch (e) { el.innerHTML = '<div class="status" style="color:red;">Erro: ' + e.message + '</div>'; }
    }

    function renderResult(el, datasets) {
      let html = '';
      for (const d of datasets) {
        const isRoute = d.mode === 'route';
        const color = isRoute ? '#c0392b' : '#1e8449';
        const icon = isRoute ? 'ANTI-PATTERN' : 'RECOMENDADO';
        html += '<div style="background: #F3F8FD; border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; border-left: 4px solid ' + color + ';">';
        html += '<div style="font-weight: 600; color: ' + color + '; margin-bottom: 6px;">' + (isRoute ? 'Via Route (externa)' : 'Via Service (interna)');
        html += ' <span style="font-size:.7rem; padding:2px 8px; border-radius:10px; background:' + (isRoute ? '#fadbd8' : '#d5f5e3') + '; color:' + color + ';">' + icon + '</span></div>';
        html += '<div style="font-family: monospace; font-size: 0.82rem; line-height: 1.8;">';
        html += '<span style="color:#555;">Destino:</span> ' + d.targetUrl + '<br>';
        html += '<span style="color:#555;">Chamadas:</span> ' + d.summary.successCount + '/' + d.iterations + ' com sucesso<br>';
        html += '<span style="color:#555;">Latencia media:</span> <strong style="font-size: 1.1rem; color:' + color + ';">' + d.summary.avgMs + ' ms</strong><br>';
        html += '<span style="color:#555;">Min / Max:</span> ' + d.summary.minMs + ' ms / ' + d.summary.maxMs + ' ms';
        html += '</div></div>';
      }

      if (datasets.length === 2) {
        const route = datasets.find(d => d.mode === 'route');
        const svc = datasets.find(d => d.mode === 'service');
        if (route && svc && route.summary.avgMs && svc.summary.avgMs) {
          const factor = (route.summary.avgMs / svc.summary.avgMs).toFixed(1);
          html += '<div style="background: #fff3cd; border-radius: 6px; padding: 12px 14px; border-left: 4px solid #f0c040; font-size: 0.88rem;">';
          html += '<strong>Resultado:</strong> A Route e <strong>' + factor + 'x mais lenta</strong> que o Service interno. ';
          html += 'Para comunicacao entre pods/namespaces, use sempre o Service DNS.';
          html += '</div>';
        }
      }

      el.innerHTML = html;

      // Show hop diagram
      const diag = document.getElementById('hopDiagram');
      const hopEl = document.getElementById('hopContent');
      if (diag && hopEl) {
        diag.style.display = 'block';
        hopEl.innerHTML =
          '<div style="display:flex; gap: 16px; flex-wrap: wrap;">' +
          '<div style="flex:1; min-width: 250px; background: #fadbd8; border-radius: 8px; padding: 12px; font-size: 0.78rem; line-height: 1.9;">' +
            '<div style="font-weight:700; color:#c0392b; margin-bottom: 4px;">Route (externa)</div>' +
            '<div style="font-family: monospace;">' +
            'Pod A (namespace X)<br>' +
            '&nbsp;&nbsp;-> OpenShift Router (HAProxy)<br>' +
            '&nbsp;&nbsp;&nbsp;&nbsp;-> DNS externo<br>' +
            '&nbsp;&nbsp;&nbsp;&nbsp;-> TLS termination<br>' +
            '&nbsp;&nbsp;-> OpenShift Router (HAProxy)<br>' +
            'Pod B (namespace Y)' +
            '</div><div style="color:#c0392b; font-weight:600; margin-top:4px;">6 hops | +latencia | +carga no Router</div>' +
          '</div>' +
          '<div style="flex:1; min-width: 250px; background: #d5f5e3; border-radius: 8px; padding: 12px; font-size: 0.78rem; line-height: 1.9;">' +
            '<div style="font-weight:700; color:#1e8449; margin-bottom: 4px;">Service (interna)</div>' +
            '<div style="font-family: monospace;">' +
            'Pod A (namespace X)<br>' +
            '&nbsp;&nbsp;-> OVN / cluster SDN<br>' +
            'Pod B (namespace Y)' +
            '</div><div style="color:#1e8449; font-weight:600; margin-top:4px;">2 hops | latencia minima | trafego interno</div>' +
          '</div>' +
          '</div>';
      }
    }
  </script>
</body>
</html>`;
}

// --- Routes ---

app.get('/', (req, res) => {
  res.send(buildHTML());
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', pod: POD_NAME, namespace: NAMESPACE });
});

app.get('/metrics', (req, res) => {
  const mem = process.memoryUsage();
  const allocatedMB = memoryBlocks.reduce((sum, b) => sum + b.length, 0) / (1024 * 1024);
  res.json({
    pod: POD_NAME,
    namespace: NAMESPACE,
    uptime: Math.floor(process.uptime()),
    cpuStressActive,
    memory: {
      rss_mb: +(mem.rss / 1024 / 1024).toFixed(1),
      heapUsed_mb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      allocated_mb: +allocatedMB.toFixed(1),
      blocks: memoryBlocks.length
    }
  });
});

app.get('/load', (req, res) => {
  const duration = Math.min(parseInt(req.query.duration) || 30, 300);
  const intensity = Math.min(parseInt(req.query.intensity) || 1, 8);

  cpuStressActive = true;
  console.log(`[CPU] Iniciando carga: duracao=${duration}s, intensidade=${intensity} threads`);

  const workers = [];
  for (let t = 0; t < intensity; t++) {
    const end = Date.now() + duration * 1000;
    const promise = new Promise((resolve) => {
      function burn() {
        if (Date.now() >= end) {
          resolve();
          return;
        }
        const until = Date.now() + 10;
        while (Date.now() < until) {
          Math.sqrt(Math.random() * 999999);
        }
        setImmediate(burn);
      }
      burn();
    });
    workers.push(promise);
  }

  Promise.all(workers).then(() => {
    cpuStressActive = false;
    console.log(`[CPU] Carga finalizada apos ${duration}s`);
  });

  res.redirect('/');
});

app.get('/allocate', (req, res) => {
  const sizeMB = Math.min(parseInt(req.query.size) || 64, 512);
  const bytes = sizeMB * 1024 * 1024;

  try {
    const block = Buffer.alloc(bytes, 0x42);
    memoryBlocks.push(block);
    console.log(`[MEM] Alocado ${sizeMB} MB (total blocos: ${memoryBlocks.length})`);
  } catch (err) {
    console.error(`[MEM] Falha na alocacao: ${err.message}`);
  }

  res.redirect('/');
});

app.get('/release', (req, res) => {
  const count = memoryBlocks.length;
  memoryBlocks.length = 0;
  memoryBlocks = [];
  if (global.gc) {
    global.gc();
    setTimeout(() => global.gc(), 500);
  }
  console.log(`[MEM] Liberados ${count} blocos`);
  res.redirect('/');
});

// --- Ping endpoint (target for latency test) ---
app.get('/ping', (req, res) => {
  res.json({ pong: true, pod: POD_NAME, namespace: NAMESPACE, ts: Date.now() });
});

// --- Cross-namespace communication test ---
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    // Force new connection each time (no keep-alive) to measure true per-request overhead
    const agent = new mod.Agent({ keepAlive: false, rejectUnauthorized: false });
    const start = process.hrtime.bigint();
    mod.get(url, { timeout: 5000, agent }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
        agent.destroy();
        try { resolve({ latencyMs: +elapsed.toFixed(2), response: JSON.parse(data) }); }
        catch (e) { resolve({ latencyMs: +elapsed.toFixed(2), response: data }); }
      });
    }).on('error', (err) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      agent.destroy();
      reject({ latencyMs: +elapsed.toFixed(2), error: err.message });
    });
  });
}

app.get('/api/call-service', async (req, res) => {
  const mode = req.query.mode; // 'route' or 'service'
  const iterations = Math.min(parseInt(req.query.n) || 5, 20);

  let targetUrl;
  let label;
  if (mode === 'route' && PEER_ROUTE) {
    targetUrl = `https://${PEER_ROUTE}/ping`;
    label = `Route (${PEER_ROUTE})`;
  } else if (mode === 'service' && PEER_SERVICE) {
    targetUrl = `http://${PEER_SERVICE}/ping`;
    label = `Service (${PEER_SERVICE})`;
  } else {
    return res.json({ error: 'Modo invalido ou variavel PEER_ROUTE / PEER_SERVICE nao configurada', mode, PEER_ROUTE, PEER_SERVICE });
  }

  const results = [];
  for (let i = 0; i < iterations; i++) {
    try {
      const r = await httpGet(targetUrl);
      results.push({ ok: true, latencyMs: r.latencyMs, peer: r.response.pod || 'unknown' });
    } catch (e) {
      results.push({ ok: false, latencyMs: e.latencyMs, error: e.error });
    }
  }

  const latencies = results.filter(r => r.ok).map(r => r.latencyMs);
  const avg = latencies.length ? +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2) : null;
  const min = latencies.length ? Math.min(...latencies) : null;
  const max = latencies.length ? Math.max(...latencies) : null;

  res.json({
    mode,
    label,
    targetUrl,
    iterations,
    results,
    summary: { avgMs: avg, minMs: min, maxMs: max, successCount: latencies.length }
  });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stress App rodando na porta ${PORT}`);
  console.log(`Pod: ${POD_NAME} | Namespace: ${NAMESPACE}`);
});
