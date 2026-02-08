const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;

let clusterDomain = process.env.CLUSTER_DOMAIN || '';

function detectClusterDomain() {
  return new Promise((resolve) => {
    // Try OpenShift API first (works inside the cluster)
    const token = (() => {
      try {
        return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
      } catch {
        return null;
      }
    })();

    if (!token) {
      console.log('No service account token found, using CLUSTER_DOMAIN env or fallback.');
      return resolve(clusterDomain);
    }

    const apiHost = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
    const apiPort = process.env.KUBERNETES_SERVICE_PORT || '443';

    const options = {
      hostname: apiHost,
      port: apiPort,
      path: '/apis/config.openshift.io/v1/ingresses/cluster',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      rejectUnauthorized: false,
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const ingress = JSON.parse(data);
          const domain = ingress.spec && ingress.spec.domain;
          if (domain) {
            console.log(`Detected cluster domain: ${domain}`);
            return resolve(domain);
          }
        } catch (e) {
          console.log('Failed to parse ingress response:', e.message);
        }
        resolve(clusterDomain);
      });
    });

    req.on('error', (e) => {
      console.log('Failed to detect cluster domain:', e.message);
      resolve(clusterDomain);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(clusterDomain);
    });

    req.end();
  });
}

// Serve static files (images, css, etc.)
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// Serve index.html with cluster domain injected
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/__CLUSTER_DOMAIN__/g, clusterDomain);
  res.type('html').send(html);
});

// Serve other static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/healthz', (req, res) => res.send('ok'));

// API to return cluster domain (useful for debugging)
app.get('/api/cluster-domain', (req, res) => {
  res.json({ domain: clusterDomain });
});

async function start() {
  const detected = await detectClusterDomain();
  if (detected) clusterDomain = detected;
  if (!clusterDomain) {
    console.log('WARNING: Cluster domain not detected. Demo links will be disabled.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Workshop slides running on port ${PORT}`);
    console.log(`Cluster domain: ${clusterDomain || '(not detected)'}`);
  });
}

start();
