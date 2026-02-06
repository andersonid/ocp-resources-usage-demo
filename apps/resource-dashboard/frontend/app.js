const REFRESH_INTERVAL = 5000;
const dashboard = document.getElementById('dashboard');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// --- Fetch & Render Loop ---
async function fetchAndRender() {
  try {
    const res = await fetch('/api/namespaces');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    statusDot.className = 'status-dot';
    statusText.textContent = 'Conectado ao cluster';

    renderDashboard(data);
  } catch (err) {
    statusDot.className = 'status-dot error';
    statusText.textContent = 'Erro: ' + err.message;
    console.error('Falha ao buscar dados:', err);
  }
}

// --- Main render ---
function renderDashboard(namespaces) {
  dashboard.innerHTML = namespaces.map(ns => renderNamespacePanel(ns)).join('');
}

function renderNamespacePanel(ns) {
  const type = ns.namespace.includes('ruim') ? 'bad' : 'good';
  const label = type === 'bad' ? 'Praticas Ruins' : 'Boas Praticas';
  const badge = type === 'bad'
    ? '<span class="ns-badge bad">Anti-pattern</span>'
    : '<span class="ns-badge good">Recomendado</span>';

  return `
    <div class="ns-panel">
      <div class="ns-header ${type}">
        <div class="ns-name">${ns.namespace} ${badge}</div>
        <div class="ns-subtitle">${label} -- ${ns.podCount} pod(s) em execucao</div>
      </div>

      ${renderResourceCard(ns)}
      ${renderHPACard(ns)}
      ${renderAntiPatterns(ns)}
      ${renderPodTable(ns)}
    </div>
  `;
}

// --- Resource bars ---
function renderResourceCard(ns) {
  const t = ns.totals;
  const maxCPU = Math.max(t.limits.cpu_millicores, t.requests.cpu_millicores, t.usage.cpu_millicores, 1);
  const maxMem = Math.max(t.limits.memory_mib, t.requests.memory_mib, t.usage.memory_mib, 1);

  return `
    <div class="card">
      <div class="card-title">Consumo de Recursos (total)</div>
      <div class="legend">
        <div class="legend-item"><div class="legend-dot usage"></div> Uso real</div>
        <div class="legend-item"><div class="legend-dot request"></div> Requests</div>
        <div class="legend-item"><div class="legend-dot limit"></div> Limits</div>
      </div>

      <div class="bar-group">
        <div class="bar-label">
          <span>CPU</span>
          <strong>${t.usage.cpu_millicores}m / ${t.requests.cpu_millicores}m request / ${t.limits.cpu_millicores}m limit</strong>
        </div>
        <div class="bar-track">
          <div class="bar-fill limit" style="width: ${pct(t.limits.cpu_millicores, maxCPU)}%"></div>
          <div class="bar-fill request" style="width: ${pct(t.requests.cpu_millicores, maxCPU)}%"></div>
          <div class="bar-fill usage" style="width: ${pct(t.usage.cpu_millicores, maxCPU)}%">
            <span class="bar-value">${t.usage.cpu_millicores}m</span>
          </div>
        </div>
      </div>

      <div class="bar-group">
        <div class="bar-label">
          <span>Memoria</span>
          <strong>${t.usage.memory_mib} Mi / ${t.requests.memory_mib} Mi request / ${t.limits.memory_mib} Mi limit</strong>
        </div>
        <div class="bar-track">
          <div class="bar-fill limit" style="width: ${pct(t.limits.memory_mib, maxMem)}%"></div>
          <div class="bar-fill request" style="width: ${pct(t.requests.memory_mib, maxMem)}%"></div>
          <div class="bar-fill usage" style="width: ${pct(t.usage.memory_mib, maxMem)}%">
            <span class="bar-value">${t.usage.memory_mib} Mi</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// --- HPA ---
function renderHPACard(ns) {
  if (!ns.hpa || ns.hpa.length === 0) {
    return `<div class="card">
      <div class="card-title">HPA (Horizontal Pod Autoscaler)</div>
      <div class="hpa-status-bar unknown">Nenhum HPA configurado</div>
    </div>`;
  }

  const h = ns.hpa[0];
  const cpuPct = h.currentCPUPercent;
  const isScaling = h.desiredReplicas > h.currentReplicas;
  const statusClass = cpuPct === null ? 'unknown' : (isScaling ? 'scaling' : 'idle');

  let statusMsg;
  if (cpuPct === null) {
    statusMsg = 'Aguardando metricas...';
  } else if (isScaling) {
    statusMsg = `Escalando! CPU em ${cpuPct}% (target: ${h.targetCPUPercent}%)`;
  } else if (cpuPct < h.targetCPUPercent) {
    statusMsg = `Estavel - CPU em ${cpuPct}% (target: ${h.targetCPUPercent}%)`;
  } else {
    statusMsg = `CPU em ${cpuPct}% - proximo do threshold`;
  }

  return `
    <div class="card">
      <div class="card-title">HPA (Horizontal Pod Autoscaler)</div>
      <div class="hpa-grid">
        <div class="hpa-stat">
          <div class="hpa-stat-value">${h.currentReplicas}</div>
          <div class="hpa-stat-label">Replicas atuais</div>
        </div>
        <div class="hpa-stat">
          <div class="hpa-stat-value">${h.desiredReplicas}</div>
          <div class="hpa-stat-label">Replicas desejadas</div>
          <div class="hpa-stat-hint">min: ${h.minReplicas} / max: ${h.maxReplicas}</div>
        </div>
        <div class="hpa-stat">
          <div class="hpa-stat-value">${cpuPct !== null ? cpuPct + '%' : '--'}</div>
          <div class="hpa-stat-label">CPU atual (%)</div>
        </div>
        <div class="hpa-stat">
          <div class="hpa-stat-value">${h.targetCPUPercent || '--'}%</div>
          <div class="hpa-stat-label">Target CPU</div>
        </div>
        <div class="hpa-status-bar ${statusClass}">${statusMsg}</div>
      </div>
    </div>
  `;
}

// --- Anti-patterns ---
function renderAntiPatterns(ns) {
  const ap = ns.antiPatterns;
  const type = ns.namespace.includes('ruim') ? 'bad' : 'good';

  if (type === 'good') {
    return `
      <div class="card">
        <div class="card-title">Analise de Configuracao</div>
        <div class="alert-box success">
          <div class="alert-item"><strong>Requests menores que limits</strong> -- permite burst e reaproveitamento de recursos</div>
          <div class="alert-item"><strong>Desperdicio de CPU:</strong> ${ap.cpuWastePercent}%</div>
          <div class="alert-item"><strong>HPA funcional</strong> -- o threshold sera atingido com carga real</div>
        </div>
      </div>`;
  }

  const alerts = [];
  if (ap.requestsEqualsLimits) {
    alerts.push('<strong>Requests = Limits (QoS Guaranteed)</strong> -- o Kubernetes nao pode realocar recursos ociosos');
  }
  alerts.push(`<strong>Desperdicio de CPU:</strong> ${ap.cpuWastePercent}% dos requests nao sao utilizados`);
  alerts.push(`<strong>Desperdicio de Memoria:</strong> ${ap.memWastePercent}% dos requests nao sao utilizados`);
  if (ap.cpuWastePercent > 80) {
    alerts.push('<strong>HPA travado</strong> -- com requests tao altos, a % de uso nunca atinge o threshold');
  }

  return `
    <div class="card">
      <div class="card-title">Anti-patterns Detectados</div>
      <div class="alert-box warning">
        ${alerts.map(a => `<div class="alert-item">${a}</div>`).join('')}
      </div>
    </div>`;
}

// --- Pod table ---
function renderPodTable(ns) {
  if (!ns.pods || ns.pods.length === 0) return '';

  const rows = ns.pods.map(p => `
    <tr>
      <td class="pod-name" title="${p.name}">${p.name}</td>
      <td>${p.usage.cpu_millicores}m</td>
      <td>${p.requests.cpu_millicores}m</td>
      <td>${p.limits.cpu_millicores}m</td>
      <td>${p.usage.memory_mib} Mi</td>
      <td>${p.requests.memory_mib} Mi</td>
      <td>${p.limits.memory_mib} Mi</td>
    </tr>
  `).join('');

  return `
    <div class="card">
      <div class="card-title">Pods</div>
      <table class="pod-table">
        <thead>
          <tr>
            <th>Pod</th>
            <th>CPU Uso</th>
            <th>CPU Req</th>
            <th>CPU Lim</th>
            <th>Mem Uso</th>
            <th>Mem Req</th>
            <th>Mem Lim</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// --- Utils ---
function pct(value, max) {
  if (max <= 0) return 0;
  return Math.min(Math.round((value / max) * 100), 100);
}

// --- Countdown + Refresh ---
const countdownEl = document.getElementById('countdown');
const REFRESH_SECONDS = REFRESH_INTERVAL / 1000;
let remaining = REFRESH_SECONDS;

function startCountdown() {
  remaining = REFRESH_SECONDS;
  if (countdownEl) countdownEl.textContent = remaining;
}

setInterval(() => {
  remaining--;
  if (remaining < 0) remaining = REFRESH_SECONDS;
  if (countdownEl) countdownEl.textContent = remaining;
}, 1000);

// --- Init ---
fetchAndRender();
startCountdown();
setInterval(() => {
  fetchAndRender();
  startCountdown();
}, REFRESH_INTERVAL);
