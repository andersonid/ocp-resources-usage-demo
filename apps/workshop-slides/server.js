const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Workshop slides running on port ${PORT}`);
});
