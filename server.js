require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { readPhoneNumbers, generateReport } = require('./services/excelService');
const { runAutomation } = require('./services/automationService');

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

// Ensure reports directory exists
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// Ensure .env file exists for the client
const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, '.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  fs.copyFileSync(envExamplePath, envPath);
  console.log('[Setup] Generated .env file. Please fill in your VI_USER_ID and VI_PASSWORD in the .env file.');
}

app.use(express.static('public'));
app.use(express.json());

// Global hook for captcha resolver
global.captchaResolve = null;

// Endpoint for the frontend to submit the manual login captcha
app.post('/solve-captcha', (req, res) => {
  const { text } = req.body;
  if (global.captchaResolve && text) {
    global.captchaResolve(text);
    global.captchaResolve = null;
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'No captcha pending or invalid text' });
  }
});

// SSE clients list
let sseClients = [];

// SSE endpoint — frontend listens here for live updates
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.push(res);
  console.log(`[SSE] Client connected. Total: ${sseClients.length}`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log(`[SSE] Client disconnected. Total: ${sseClients.length}`);
  });
});

// Broadcast event to all SSE clients
function sendEvent(data) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const numbers = readPhoneNumbers(req.file.path);

    if (numbers.length === 0) {
      return res.status(400).json({ error: 'No phone numbers found in the Excel file. Make sure column is named "phone_number"' });
    }

    res.json({ success: true, count: numbers.length, message: `Found ${numbers.length} numbers. Starting automation...` });

    // Delay automation slightly to give the frontend time to connect to /events SSE
    setTimeout(() => {
      runAutomation(numbers, sendEvent)
        .then(results => {
          const reportFilename = generateReport(results);
          sendEvent({ 
            type: 'done', 
            results, 
            reportUrl: `/download-report/${reportFilename}` 
          });
        })
        .catch(err => {
          console.error('[Automation Error]', err);
          sendEvent({ type: 'error', message: err.message });
        });
    }, 2000);

    // Clean up uploaded file after reading
    fs.unlink(req.file.path, () => {});

  } catch (err) {
    console.error('[Upload Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Download report endpoint
app.get('/download-report/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const filePath = path.join(__dirname, 'reports', filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'Report file not found' });
  }
});

const PORT = process.env.PORT || 3000;

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n✅  Server running → http://localhost:${port}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${port} is already in use.`);
      const nextPort = parseInt(port) + 1;
      console.log(`👉  Trying fallback port ${nextPort}...`);
      startServer(nextPort);
    } else {
      console.error('[Server Error]', err);
    }
  });
}

startServer(PORT);
