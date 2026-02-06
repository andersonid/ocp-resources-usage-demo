const express = require('express');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const POD_NAME = process.env.HOSTNAME || 'desconhecido';
const NAMESPACE = process.env.NAMESPACE || 'desconhecido';

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

// --- HTML UI ---
function buildHTML() {
  const memUsage = process.memoryUsage();
  const memAllocatedMB = memoryBlocks.reduce((sum, b) => sum + b.length, 0) / (1024 * 1024);
  const t = getTheme();

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
      <h2>Carga de CPU</h2>
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
      <h2>Alocacao de Memoria</h2>
      <p>Aloca blocos de memoria para demonstrar os limits de memoria.</p>
      <div style="margin-top: 12px;">
        <a class="btn btn-stress" href="/allocate?size=64">+64 MB</a>
        <a class="btn btn-stress" href="/allocate?size=128">+128 MB</a>
        <a class="btn btn-stress" href="/allocate?size=256">+256 MB</a>
        <a class="btn btn-release" href="/release">Liberar Tudo</a>
      </div>
      <div class="status">
        <span class="label">Blocos alocados:</span> ${memoryBlocks.length}<br>
        <span class="label">Total alocado:</span> ${memAllocatedMB.toFixed(1)} MB<br>
        <span class="label">RSS:</span> ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB<br>
        <span class="label">Heap em uso:</span> ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB
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
  </div>
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
  memoryBlocks = [];
  if (global.gc) global.gc();
  console.log(`[MEM] Liberados ${count} blocos`);
  res.redirect('/');
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stress App rodando na porta ${PORT}`);
  console.log(`Pod: ${POD_NAME} | Namespace: ${NAMESPACE}`);
});
