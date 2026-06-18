# Vi Number Blocker

Bulk phone number blocking tool for Vi dealer portal.

## Setup

```bash
npm install
npx playwright install chromium
node server.js
```

Then open: http://localhost:3000

## Excel Format

Your .xlsx file should have a column named one of:
- `phone_number`
- `mobile`
- `number`

## ⚠️  IMPORTANT — Update Selectors

Open `services/automationService.js` and update the SELECTORS object.

To find correct selectors:
1. Open the portal in Chrome
2. Right-click on each field (phone input, captcha image, captcha input, submit button)
3. Click Inspect
4. Right-click the highlighted element → Copy → Copy selector
5. Paste into SELECTORS in automationService.js

## If Login is Required

Uncomment these 3 lines in automationService.js:
```
// console.log('\n👉  Please log in manually...');
// await new Promise(resolve => process.stdin.once('data', resolve));
// console.log('[Browser] Continuing...');
```

The browser will open, you log in manually, then press ENTER in terminal.
