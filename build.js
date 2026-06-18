const fs = require('fs');
const path = require('path');

// Read BACKEND_URL from process.env (Vercel will inject this during the build phase)
const backendUrl = process.env.BACKEND_URL || '';

// Create a small JS file inside /public that exposes the environment variables to the frontend
const envJsContent = `window.ENV = { BACKEND_URL: "${backendUrl}" };\n`;
const outputPath = path.join(__dirname, 'public', 'env.js');

fs.writeFileSync(outputPath, envJsContent);
console.log(`✅ Environment variables injected into ${outputPath} (BACKEND_URL: ${backendUrl || 'None / Relative'})`);
