const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const POD_NAME = process.env.HOSTNAME || 'unknown';
const NAMESPACE = process.env.NAMESPACE || 'unknown';

// ---------------------------------------------------------------------------
// Memory limit detection (cgroups)
// ---------------------------------------------------------------------------
function getMemoryLimitMB() {
  const paths = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes'
  ];
  for (const p of paths) {
    try {
      const val = fs.readFileSync(p, 'utf8').trim();
      if (val === 'max' || val === '9223372036854771712') return null;
      return Math.round(parseInt(val) / (1024 * 1024));
    } catch (e) { /* next */ }
  }
  return null;
}
const MEMORY_LIMIT_MB = getMemoryLimitMB();

// ---------------------------------------------------------------------------
// Workload simulation engine
// ---------------------------------------------------------------------------

// Configuration -- Peak / off-peak plateau pattern
// Full cycle: PEAK_MINUTES (high plateau) + OFF_MINUTES (low plateau) = ~2h total
const PEAK_MINUTES    = 60;   // sustained high-traffic plateau
const OFF_MINUTES     = 60;   // sustained low-traffic plateau
const RAMP_MINUTES    = 5;    // transition ramp between plateaus
const CYCLE_MINUTES   = PEAK_MINUTES + OFF_MINUTES + (RAMP_MINUTES * 2); // total cycle
const MAX_USERS       = 80;   // peak simulated concurrent users
const MIN_USERS       = 5;    // off-hours baseline
const PEAK_BASE       = 65;   // base users during peak plateau (varies around this)
const OFF_BASE        = 10;   // base users during off-hours (varies around this)
const TICK_INTERVAL   = 2000; // ms between simulation ticks
const BURST_CHANCE    = 0.02; // 2% chance of random traffic burst during peak
const BURST_MULTIPLIER = 1.8;

// State
let currentUsers  = MIN_USERS;
let cpuBusy       = false;
let memoryBlocks  = [];      // held memory buffers
let targetMemMB   = 0;
let stats = {
  totalRequests: 0,
  tickCount: 0,
  startTime: Date.now(),
  lastBurst: null,
  peakUsers: 0,
  peakCpuMs: 0,
  peakMemMB: 0,
};

// Compute current simulated users based on peak/off-peak plateau pattern
// Pattern: [ramp-up] [peak plateau ~1h] [ramp-down] [off-hours plateau ~1h] [repeat]
function computeUsers() {
  const elapsed = (Date.now() - stats.startTime) / 1000; // seconds
  const cycleSec = CYCLE_MINUTES * 60;
  const rampSec = RAMP_MINUTES * 60;
  const peakSec = PEAK_MINUTES * 60;
  const offSec = OFF_MINUTES * 60;

  const posInCycle = elapsed % cycleSec;

  let base;

  if (posInCycle < rampSec) {
    // Phase 1: Ramp up (off -> peak)
    const progress = posInCycle / rampSec; // 0..1
    base = OFF_BASE + (PEAK_BASE - OFF_BASE) * progress;
  } else if (posInCycle < rampSec + peakSec) {
    // Phase 2: Peak plateau (~1h sustained high traffic)
    base = PEAK_BASE;
  } else if (posInCycle < rampSec + peakSec + rampSec) {
    // Phase 3: Ramp down (peak -> off)
    const progress = (posInCycle - rampSec - peakSec) / rampSec; // 0..1
    base = PEAK_BASE - (PEAK_BASE - OFF_BASE) * progress;
  } else {
    // Phase 4: Off-hours plateau (~1h sustained low traffic)
    base = OFF_BASE;
  }

  // Small natural variation (+/- 12%) -- mimics real user fluctuation
  const noise = base * (0.88 + Math.random() * 0.24);

  // Random burst (only during peak hours)
  let burst = 1;
  if (posInCycle >= rampSec && posInCycle < rampSec + peakSec) {
    if (Math.random() < BURST_CHANCE) {
      burst = BURST_MULTIPLIER;
      stats.lastBurst = new Date().toISOString();
    }
  }

  return Math.max(MIN_USERS, Math.min(MAX_USERS * BURST_MULTIPLIER, Math.round(noise * burst)));
}

// CPU work: simulate request processing proportional to users
function doCpuWork(users) {
  cpuBusy = true;
  const iterations = users * 8000; // ~proportional CPU work
  let hash = 0;
  for (let i = 0; i < iterations; i++) {
    hash = (hash * 31 + i) % 1000000007;
  }
  cpuBusy = false;
  return hash;
}

// Memory work: hold buffers proportional to users (simulates sessions/cache)
function adjustMemory(users) {
  // Target: ~0.5 MB per user (session data, cache, etc.)
  targetMemMB = Math.round(users * 0.5);
  const currentMB = memoryBlocks.reduce((sum, b) => sum + b.length, 0) / (1024 * 1024);

  if (currentMB < targetMemMB) {
    // Allocate more
    const needed = Math.ceil(targetMemMB - currentMB);
    for (let i = 0; i < needed; i++) {
      try {
        const block = Buffer.alloc(1024 * 1024, Math.floor(Math.random() * 256));
        memoryBlocks.push(block);
      } catch (e) { break; }
    }
  } else if (currentMB > targetMemMB + 2) {
    // Free some
    const excess = Math.ceil(currentMB - targetMemMB);
    for (let i = 0; i < excess && memoryBlocks.length > 0; i++) {
      memoryBlocks.pop();
    }
  }
}

// Main simulation tick
function simulationTick() {
  currentUsers = computeUsers();
  stats.tickCount++;
  stats.totalRequests += currentUsers;

  // CPU work
  const t0 = process.hrtime.bigint();
  doCpuWork(currentUsers);
  const cpuMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Memory adjustment
  adjustMemory(currentUsers);

  // Track peaks
  if (currentUsers > stats.peakUsers) stats.peakUsers = currentUsers;
  if (cpuMs > stats.peakCpuMs) stats.peakCpuMs = cpuMs;

  const memUsed = process.memoryUsage().rss / (1024 * 1024);
  if (memUsed > stats.peakMemMB) stats.peakMemMB = memUsed;
}

// Start simulation loop
setInterval(simulationTick, TICK_INTERVAL);

// ---------------------------------------------------------------------------
// Serve static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  const memUsage = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - stats.startTime) / 1000);
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  res.json({
    pod: POD_NAME,
    namespace: NAMESPACE,
    memoryLimitMB: MEMORY_LIMIT_MB,
    uptime: `${hours}h ${mins}m`,
    uptimeSeconds: uptimeSec,
    simulation: {
      currentUsers,
      targetMemMB,
      cycleMinutes: CYCLE_MINUTES,
      peakMinutes: PEAK_MINUTES,
      offMinutes: OFF_MINUTES,
      rampMinutes: RAMP_MINUTES,
      peakBase: PEAK_BASE,
      offBase: OFF_BASE,
      maxUsers: MAX_USERS,
      minUsers: MIN_USERS,
      tickIntervalMs: TICK_INTERVAL,
    },
    memory: {
      rssMB: Math.round(memUsage.rss / (1024 * 1024)),
      heapUsedMB: Math.round(memUsage.heapUsed / (1024 * 1024)),
      heldBlocksMB: Math.round(memoryBlocks.reduce((s, b) => s + b.length, 0) / (1024 * 1024)),
    },
    stats: {
      totalRequests: stats.totalRequests,
      tickCount: stats.tickCount,
      peakUsers: stats.peakUsers,
      peakMemMB: Math.round(stats.peakMemMB),
      lastBurst: stats.lastBurst,
    },
  });
});

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  const theme = '#1a5276'; // neutral blue
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Simulador de Carga - VPA Demo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f4f6f8; color: #333; }
    .topbar { background: ${theme}; color: #fff; padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
    .topbar img { height: 36px; border-radius: 6px; background: #fff; padding: 4px 8px; }
    .topbar h1 { font-size: 1.15rem; font-weight: 500; }
    .topbar .badge { background: rgba(255,255,255,.15); padding: 4px 10px; border-radius: 12px; font-size: .75rem; margin-left: auto; }
    .container { max-width: 900px; margin: 24px auto; padding: 0 16px; }
    .info-banner { background: #eaf2f8; border-left: 4px solid ${theme}; padding: 14px 18px; border-radius: 6px; margin-bottom: 20px; font-size: .9rem; line-height: 1.5; }
    .info-banner strong { color: ${theme}; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .card { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); text-align: center; }
    .card-value { font-size: 2rem; font-weight: 700; color: ${theme}; }
    .card-label { font-size: .8rem; color: #777; margin-top: 4px; }
    .card-sub { font-size: .7rem; color: #aaa; margin-top: 2px; }
    .chart-container { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 20px; }
    .chart-title { font-size: .9rem; font-weight: 600; margin-bottom: 12px; color: #555; }
    canvas { width: 100% !important; height: 200px !important; }
    .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .bar-label { width: 80px; font-size: .8rem; font-weight: 600; text-align: right; }
    .bar-track { flex: 1; height: 24px; background: #eee; border-radius: 6px; overflow: hidden; position: relative; }
    .bar-fill { height: 100%; border-radius: 6px; transition: width .5s ease; }
    .bar-fill.cpu { background: linear-gradient(90deg, #3498db, #2980b9); }
    .bar-fill.mem { background: linear-gradient(90deg, #2ecc71, #27ae60); }
    .bar-text { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: .7rem; font-weight: 600; color: #333; }
    .cmd-card { background: #1e2a35; border-radius: 10px; padding: 14px 18px; display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .cmd-label { color: #8fa3b0; font-size: .78rem; font-weight: 600; white-space: nowrap; }
    .cmd-code { flex: 1; background: #0d1b26; color: #58d68d; font-family: 'SF Mono', 'Cascadia Code', 'Courier New', monospace; font-size: .78rem; padding: 8px 12px; border-radius: 6px; border: 1px solid #2c3e50; overflow-x: auto; white-space: nowrap; }
    .cmd-copy { background: #1a5276; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-size: .75rem; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background .2s; }
    .cmd-copy:hover { background: #2980b9; }
    .cmd-copy.copied { background: #27ae60; }
    .footer { text-align: center; font-size: .75rem; color: #aaa; padding: 16px; }
  </style>
</head>
<body>
  <div class="topbar">
    <img src="logo.png" alt="Logo">
    <h1>Simulador de Carga</h1>
    <span class="badge" id="uptime">--</span>
  </div>

  <div class="container">
    <div class="info-banner">
      <strong>Simulação de carga automática</strong> -- Esta aplicação simula um backend de API com tráfego
      oscilante: <strong>${PEAK_MINUTES} min de pico</strong> (~${PEAK_BASE} usuários) seguidos de
      <strong>${OFF_MINUTES} min fora de pico</strong> (~${OFF_BASE} usuários), com transições graduais de ${RAMP_MINUTES} min.
      <br>O VPA coleta essas métricas ao longo do tempo para recomendar valores ideais de requests e limits.
      <br>Ciclo completo: <strong>${CYCLE_MINUTES} minutos</strong> (~2h).
    </div>

    <div class="grid">
      <div class="card">
        <div class="card-value" id="users">--</div>
        <div class="card-label">Usuários simulados</div>
        <div class="card-sub">min: ${MIN_USERS} / max: ${MAX_USERS}</div>
      </div>
      <div class="card">
        <div class="card-value" id="requests">--</div>
        <div class="card-label">Requests simulados</div>
        <div class="card-sub">acumulado total</div>
      </div>
      <div class="card">
        <div class="card-value" id="memHeld">--</div>
        <div class="card-label">Memória alocada (MB)</div>
        <div class="card-sub">sessões/cache simulados</div>
      </div>
      <div class="card">
        <div class="card-value" id="rss">--</div>
        <div class="card-label">RSS total (MB)</div>
        <div class="card-sub" id="memLimit">--</div>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-title">Uso de recursos</div>
      <div class="bar-row">
        <div class="bar-label">CPU</div>
        <div class="bar-track">
          <div class="bar-fill cpu" id="cpuBar" style="width: 0%"></div>
          <div class="bar-text" id="cpuText">--</div>
        </div>
      </div>
      <div class="bar-row">
        <div class="bar-label">Memória</div>
        <div class="bar-track">
          <div class="bar-fill mem" id="memBar" style="width: 0%"></div>
          <div class="bar-text" id="memText">--</div>
        </div>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-title">Histórico de usuários simulados (últimos 10 min)</div>
      <canvas id="chart"></canvas>
    </div>

    <div class="cmd-card">
      <span class="cmd-label">Recomendações do VPA:</span>
      <code class="cmd-code" id="vpaCmd">oc describe vpa workload-simulator -n vpa-demo | grep -A 20 "Container Recommendations"</code>
      <button class="cmd-copy" onclick="copyCmd()" id="copyBtn" title="Copiar comando">Copiar</button>
    </div>
  </div>

  <div class="footer">
    Pod: <span id="podName">--</span> | Namespace: <span id="nsName">--</span> | Atualiza a cada 3s
  </div>

  <script>
    const history = [];
    const MAX_HISTORY = 200; // 200 * 3s = 10min

    function drawChart(canvas, data) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width = canvas.offsetWidth;
      const h = canvas.height = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);

      if (data.length < 2) return;
      const max = Math.max(...data, 10);
      const step = w / (MAX_HISTORY - 1);

      // Grid lines
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = h * i / 4;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Area fill
      ctx.beginPath();
      ctx.moveTo(0, h);
      data.forEach((v, i) => {
        const x = i * step;
        const y = h - (v / max) * (h - 10);
        if (i === 0) ctx.lineTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineTo((data.length - 1) * step, h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(26, 82, 118, 0.1)';
      ctx.fill();

      // Line
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = i * step;
        const y = h - (v / max) * (h - 10);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#1a5276';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Labels
      ctx.fillStyle = '#999';
      ctx.font = '11px sans-serif';
      ctx.fillText(max + ' users', 4, 14);
      ctx.fillText('0', 4, h - 4);
    }

    async function refresh() {
      try {
        const res = await fetch('/api/status');
        const d = await res.json();

        document.getElementById('users').textContent = d.simulation.currentUsers;
        document.getElementById('requests').textContent = d.stats.totalRequests.toLocaleString();
        document.getElementById('memHeld').textContent = d.memory.heldBlocksMB;
        document.getElementById('rss').textContent = d.memory.rssMB;
        document.getElementById('uptime').textContent = d.uptime;
        document.getElementById('podName').textContent = d.pod;
        document.getElementById('nsName').textContent = d.namespace;

        if (d.memoryLimitMB) {
          document.getElementById('memLimit').textContent = 'limit: ' + d.memoryLimitMB + ' MB';
          const memPct = Math.min(Math.round(d.memory.rssMB / d.memoryLimitMB * 100), 100);
          document.getElementById('memBar').style.width = memPct + '%';
          document.getElementById('memText').textContent = d.memory.rssMB + ' / ' + d.memoryLimitMB + ' MB';
        } else {
          document.getElementById('memLimit').textContent = 'sem limit definido';
          document.getElementById('memBar').style.width = '0%';
          document.getElementById('memText').textContent = d.memory.rssMB + ' MB';
        }

        // CPU bar -- approximate from users/maxUsers
        const cpuPct = Math.min(Math.round(d.simulation.currentUsers / (d.simulation.maxUsers * 1.2) * 100), 100);
        document.getElementById('cpuBar').style.width = cpuPct + '%';
        document.getElementById('cpuText').textContent = d.simulation.currentUsers + ' users ativo(s)';

        // History chart
        history.push(d.simulation.currentUsers);
        if (history.length > MAX_HISTORY) history.shift();
        drawChart(document.getElementById('chart'), history);
      } catch (e) {
        console.error('Erro ao buscar status:', e);
      }
    }

    function copyCmd() {
      const text = document.getElementById('vpaCmd').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copiado!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2000);
      });
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log('Workload Simulator running on port ' + PORT);
  console.log('Memory limit detected: ' + (MEMORY_LIMIT_MB ? MEMORY_LIMIT_MB + ' MB' : 'none'));
  console.log('Pattern: ' + PEAK_MINUTES + 'min peak (' + PEAK_BASE + ' users) + ' + OFF_MINUTES + 'min off (' + OFF_BASE + ' users) | Ramp: ' + RAMP_MINUTES + 'min');
});
