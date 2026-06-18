const { chromium } = require('playwright');
const { solveCaptcha } = require('./captchaService');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://cpos4.vodafoneidea.com/cPOSWeb/jsp/inventory/cellNumberBlockRelease.do?method=blockCellNumbers&entityType=22';
const STATUS_VIEW_URL = 'https://cpos4.vodafoneidea.com/cPOSWeb/switchMod.do?prefix=/jsp/inventory&page=/cellNumberBlockRelease.do?method=getView&fromMenu=Y';

const CREDENTIALS = {
  username: process.env.VI_USER_ID,
  password: process.env.VI_PASSWORD,
};

const DELAY_BETWEEN_NUMBERS = 2000; // ms

/**
 * Captures and pre-processes the captcha image element in the page context.
 * Returns a clean binary image buffer.
 * @param {Page} page 
 * @param {ElementHandle} captchaImgEl 
 * @returns {Promise<Buffer>}
 */
async function captureProcessedCaptcha(page, captchaImgEl) {
  const base64Data = await page.evaluate(async (img) => {
    return new Promise((resolve, reject) => {
      if (!img) {
        reject(new Error('Image element is null'));
        return;
      }

      const process = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          // Crop 4 pixels from all sides of the original image to remove the black border
          const cropX = img.naturalWidth > 20 ? 4 : 0;
          const cropY = img.naturalHeight > 20 ? 4 : 0;
          const srcWidth = img.naturalWidth - (cropX * 2);
          const srcHeight = img.naturalHeight - (cropY * 2);

          const scale = 3;
          canvas.width = srcWidth * scale;
          canvas.height = srcHeight * scale;

          ctx.drawImage(img, cropX, cropY, srcWidth, srcHeight, 0, 0, canvas.width, canvas.height);

          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Grayscale
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;

            // Threshold: text is black (dark), noise lines and background are light
            const threshold = 140;
            const binaryColor = (gray < threshold) ? 0 : 255;

            data[i] = binaryColor;
            data[i + 1] = binaryColor;
            data[i + 2] = binaryColor;
            data[i + 3] = 255;
          }

          ctx.putImageData(imgData, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          reject(new Error('Canvas conversion failed: ' + e.message));
        }
      };

      if (!img.complete || img.naturalWidth === 0) {
        img.onload = process;
        img.onerror = () => reject(new Error('Image failed to load'));
      } else {
        process();
      }
    });
  }, captchaImgEl);

  const base64Cleaned = base64Data.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(base64Cleaned, 'base64');
}

/**
 * Executes bulk number blocking
 * @param {string[]} phoneNumbers 
 * @param {Function} sendEvent 
 * @returns {Promise<Array>}
 */
async function runAutomation(phoneNumbers, sendEvent) {
  console.log(`[Automation] Starting bulk blocking for ${phoneNumbers.length} numbers.`);
  
  if (!CREDENTIALS.username || !CREDENTIALS.password) {
    throw new Error('Missing credentials! Please set VI_USER_ID and VI_PASSWORD in your .env file or environment variables.');
  }

  // Launch browser for cloud
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  // Automatically handle and accept browser dialogs/alerts to confirm actions and prevent hangs
  page.on('dialog', async dialog => {
    console.log(`[Browser Alert] Dialog type: ${dialog.type()}, message: ${dialog.message()}`);
    console.log('[Browser Alert] Automatically accepting dialog to proceed...');
    await dialog.accept().catch(() => { });
  });

  try {
    console.log('[Browser] Opening portal...');
    sendEvent({
      type: 'progress',
      number: '',
      status: 'opening_portal',
      index: 0,
      total: phoneNumbers.length,
      message: 'Opening cPOS portal...'
    });

    await page.goto(PORTAL_URL, { waitUntil: 'load', timeout: 45000 });

    // Defensive wait: resolve navigation redirects and find either login or dashboard element
    console.log('[Browser] Waiting for page initialization...');
    await page.waitForSelector('input[name="username"], select[name="numberStatus"]', { timeout: 20000 });

    const isLoginPage = await page.$('input[name="username"]');
    if (isLoginPage) {
      console.log('[Login] Login page detected. Starting automatic credentials submission...');
      sendEvent({
        type: 'progress',
        number: '',
        status: 'logging_in',
        index: 0,
        total: phoneNumbers.length,
        message: 'Pre-filling login credentials...'
      });

      // Fill credentials
      await page.fill('input[name="username"]', CREDENTIALS.username);
      await page.fill('input[name="password"]', CREDENTIALS.password);
      await page.waitForTimeout(500);

      // Generate CAPTCHA so it is ready for the user to type
      const captchaField = await page.$('#captcha-field');
      if (!captchaField) {
        console.log('[Login] Generating login captcha...');
        await page.click('text="Generate Captcha"').catch(() => { });
        await page.waitForSelector('#captcha-field', { timeout: 10000 }).catch(() => { });
      }

      console.log('\n[Login] Requesting manual CAPTCHA solving via UI...');

      let captchaImgEl = await page.$('#captcha-image') || await page.$('img[src*="captcha"]') || await page.$('img[id*="captcha"]') || await page.$('form img');
      if (captchaImgEl) {
        const captchaBuffer = await captchaImgEl.screenshot();
        const base64Image = captchaBuffer.toString('base64');
        sendEvent({
          type: 'login_captcha_required',
          imageBase64: base64Image,
          message: 'Please enter the login CAPTCHA in the UI.'
        });
      } else {
        sendEvent({
          type: 'login_captcha_required',
          imageBase64: null,
          message: 'Please enter the login CAPTCHA in the UI (Image not detected automatically).'
        });
      }

      console.log('[Login] Waiting for frontend CAPTCHA submission...');
      const userCaptchaSolution = await new Promise((resolve) => {
        global.captchaResolve = resolve;

        // Timeout after 3 minutes
        setTimeout(() => {
          if (global.captchaResolve === resolve) {
            global.captchaResolve = null;
            resolve(null);
          }
        }, 180000);
      });

      if (!userCaptchaSolution) {
        throw new Error('Manual login timed out. No CAPTCHA submitted within 3 minutes.');
      }

      console.log('[Login] Received CAPTCHA solution from UI. Submitting...');
      await page.fill('#captcha-field', userCaptchaSolution);
      await page.waitForTimeout(500);

      // Click Login button
      const loginBtn = await page.$('a:has-text("Login")') || await page.$('input[type="submit"]') || await page.$('button');
      if (loginBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => { }),
          loginBtn.evaluate(b => b.click())
        ]);
      } else {
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => { });
      }

      // Re-verify login success
      const numberBlockLink = await page.$('text="Number block/unblock"');
      const isStatusView = await page.$('select[name="numberStatus"]');
      if (!numberBlockLink && !isStatusView) {
        throw new Error('Login failed. Please check credentials and CAPTCHA and try again.');
      }

      console.log('[Login] Login completed successfully!');
      sendEvent({
        type: 'progress',
        number: '',
        status: 'logging_in',
        index: 0,
        total: phoneNumbers.length,
        message: 'Session detected! Reached dashboard. Resuming automated run...'
      });

      // Navigate directly to status view URL to bypass hidden hover menus
      console.log('[Dashboard] Navigating directly to Number block/unblock page...');
      await page.goto(STATUS_VIEW_URL, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1000);
      await page.waitForSelector('select[name="numberStatus"]', { timeout: 20000 });
      console.log('[Dashboard] Reached Number block/unblock status view page.');
    } else {
      console.log('[Login] Session already active. Navigating directly to status view page.');
      await page.goto(STATUS_VIEW_URL, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1000);
      await page.waitForSelector('select[name="numberStatus"]', { timeout: 20000 });
      console.log('[Dashboard] Reached Number block/unblock status view page.');
    }

    // Sequentially process each phone number
    const results = [];

    for (let i = 0; i < phoneNumbers.length; i++) {
      const number = phoneNumbers[i];
      const timestamp = new Date().toISOString();
      console.log(`\n[${i + 1}/${phoneNumbers.length}] Processing mobile number: ${number}`);
      sendEvent({
        type: 'progress',
        number,
        status: 'processing',
        index: i + 1,
        total: phoneNumbers.length,
        message: `Processing number ${number}...`
      });

      let success = false;
      let failureReason = '';
      let diagnosticInfo = 'Attempted sequential block workflow';
      let solvedMathText = '';

      try {
        // Step 1: Status Check Page Form entry
        const selectSelector = 'select[name="numberStatus"]';
        console.log(`[Status Check] Selecting AVAILABLE status & entering: ${number}`);

        // Wait for select element to be visible and stable
        await page.waitForSelector(selectSelector, { state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1000); // Settle time to avoid dynamic page scripts resetting the field

        // Wait for option 191 to be present in DOM
        await page.waitForFunction((sel) => {
          const selectEl = document.querySelector(sel);
          if (!selectEl) return false;
          return Array.from(selectEl.options).some(opt => opt.value === '191');
        }, selectSelector, { timeout: 10000 });

        // Select status AVAILABLE
        await page.selectOption(selectSelector, '191');
        await page.fill('input[name="cellNumber"]', number);
        await page.waitForTimeout(500);

        // Verify selection is still correct just before clicking Go (defending against dynamic resets)
        let currentStatus = await page.$eval(selectSelector, el => el.value);
        if (currentStatus !== '191') {
          console.warn(`[Status Check] Warning: Number status was reset to "${currentStatus}". Reselecting "191"...`);
          await page.selectOption(selectSelector, '191');
          await page.waitForTimeout(500);
        }

        // Click Go (specifically target link with method=getViewAll) and wait for page to reload/navigate
        console.log('[Status Check] Clicking Go...');
        const goBtn = await page.$('a[onclick*="getViewAll"]');
        if (goBtn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => { }),
            goBtn.evaluate(b => b.click())
          ]);
        } else {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => { }),
            page.click('a[onclick*="getViewAll"]').catch(() => { })
          ]);
        }

        console.log('[Status Check] Waiting for Math Captcha input or page error...');
        await page.waitForFunction(() => {
          const body = document.body;
          if (!body) return false;

          const captchaInput = document.querySelector('#captchaInput');
          if (captchaInput && captchaInput.getBoundingClientRect().width > 0) {
            return true;
          }

          // Match any red fonts or generic error elements
          const redElements = Array.from(document.querySelectorAll('font[color="red"], .error-msg, .error, span[style*="color: red"], td[style*="color: red"]'));
          const visibleError = redElements.some(el => el.innerText && el.getBoundingClientRect().width > 0);
          if (visibleError) {
            return true;
          }

          const text = body.innerText || '';
          if (text.includes('No record') || text.includes('invalid status') || text.includes('select Number Status')) {
            return true;
          }

          return false;
        }, { timeout: 20000 });

        // Check if there was an immediate error on the status page
        if (!await page.$('#captchaInput')) {
          const pageTextBeforeCaptcha = await page.innerText('body');
          let errText = '';
          const errEl = await page.$('font[color="red"], .error-msg, .error, span[style*="color: red"], td[style*="color: red"]');
          if (errEl) {
            errText = await errEl.innerText().catch(() => '');
          }
          const fullErrText = (errText || pageTextBeforeCaptcha).toLowerCase();

          if (fullErrText.includes('already blocked') || fullErrText.includes('no record') || fullErrText.includes('invalid status')) {
            console.log(`[Status Check] Number ${number} is already blocked or no available record found. Treating as success.`);
            success = true;
            failureReason = '';
            diagnosticInfo = 'Already blocked or no record found.';
            throw new Error('SUCCESS_SKIP');
          } else {
            throw new Error(`cPOS Status view error: ${pageTextBeforeCaptcha.trim().substring(0, 200)}`);
          }
        }

        // Step 2: Math Verification Page
        console.log('[Verification] Reached Math Captcha Verification page. Starting captcha solving loop...');

        let mathSolved = false;

        for (let mathAttempt = 1; mathAttempt <= 5; mathAttempt++) {
          if (page.isClosed()) {
            throw new Error('Browser window was closed during CAPTCHA solving.');
          }

          // Find captcha image element freshly inside the loop to avoid stale element handle exceptions!
          let captchaImgEl = await page.$('#captchaImage');

          if (!captchaImgEl) {
            const imgs = await page.$$('img');
            const imgDetails = [];
            for (const img of imgs) {
              const src = (await img.getAttribute('src').catch(() => '')) || '';
              const id = (await img.getAttribute('id').catch(() => '')) || '';
              const name = (await img.getAttribute('name').catch(() => '')) || '';
              imgDetails.push(`id="${id}" name="${name}" src="${src}"`);

              // If it's not a logo, arrow, or icon, it is our math captcha image!
              if (src && !src.toLowerCase().includes('logo') && !src.toLowerCase().includes('arrow') && !src.toLowerCase().includes('icon')) {
                captchaImgEl = img;
              }
            }
            console.log(`[Verification] Scanned page images: [${imgDetails.join(' | ')}]`);

            if (!captchaImgEl) {
              // Secondary fallback search
              captchaImgEl = await page.$('img[src*="captcha"]') ||
                await page.$('img[src*="Captcha"]') ||
                await page.$('tr:has-text("Captcha") img') ||
                await page.$('form img');
            }

            if (!captchaImgEl) {
              throw new Error(`Math Captcha image element not found on the page. Scanned images: [${imgDetails.join(' | ')}]`);
            }
          }

          const imgBuffer = await captureProcessedCaptcha(page, captchaImgEl);

          // Save a debug copy of the processed image to reports folder
          try {
            const debugImgPath = path.join(__dirname, '..', 'reports', `debug_processed_captcha_${mathAttempt}.png`);
            fs.writeFileSync(debugImgPath, imgBuffer);
            console.log(`[Verification] Saved processed captcha image to: ${debugImgPath}`);
          } catch (debugErr) {
            console.warn('[Verification] Could not save debug processed image:', debugErr.message);
          }

          console.log(`[Verification] Solving Math CAPTCHA (attempt ${mathAttempt})...`);

          solvedMathText = await solveCaptcha(imgBuffer, { isMath: true });
          console.log(`[Verification] Solved math captcha text: ${solvedMathText}`);

          if (!solvedMathText || isNaN(solvedMathText)) {
            console.warn(`[Verification] Solution is not a valid number: "${solvedMathText}". Refreshing captcha...`);
            await page.click('text="Refresh Captcha"').catch(() => { });
            await page.waitForTimeout(1500);
            continue;
          }

          // Fill math solution
          await page.fill('#captchaInput', solvedMathText);
          await page.waitForTimeout(500);

          // Click Verify and wait for page to submit/reload
          console.log('[Verification] Clicking Verify...');
          const verifyBtn = await page.$('a:has-text("Verify")') || await page.$('text=Verify') || await page.$('b:has-text("Verify")');
          if (verifyBtn) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => { }),
              verifyBtn.evaluate(b => b.click())
            ]);
          } else {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => { }),
              page.click('a:has-text("Verify")').catch(() => { })
            ]);
          }

          // Settle time for page navigation/AJAX state
          await page.waitForTimeout(1000);

          // Check if we reached the block execution page (checkbox and block button must be visible, captchaInput must not be visible)
          const checkbox = await page.$('input[name="checkbox"]');
          const isCheckboxVisible = checkbox ? await checkbox.isVisible().catch(() => false) : false;
          const blockButton = await page.$('a[href*="blockCellNumber"]') || await page.$('a[onclick*="blockCellNumber"]') || await page.$('a:text-is("Block")');
          const isBlockButtonVisible = blockButton ? await blockButton.isVisible().catch(() => false) : false;
          const captchaInput = await page.$('#captchaInput');
          const isCaptchaInputVisible = captchaInput ? await captchaInput.isVisible().catch(() => false) : false;

          if (isCheckboxVisible && isBlockButtonVisible && !isCaptchaInputVisible) {
            mathSolved = true;
            console.log('[Verification] Verification successful! Math CAPTCHA bypassed.');
            break;
          } else {
            console.warn('[Verification] Captcha verification failed. Captcha input page is still shown.');
            // Read any inline error messages
            const errEl = await page.$('font[color="red"], .error-msg, .error');
            if (errEl) {
              const errMsg = await errEl.innerText().catch(() => '');
              console.warn(`[Verification] Portal error: ${errMsg.trim()}`);

              const errMsgLower = errMsg.toLowerCase();
              if (errMsgLower.includes('no records') || errMsgLower.includes('already blocked') || errMsgLower.includes('invalid status')) {
                console.log(`[Verification] Number ${number} is already blocked or no available record found. Treating as success.`);
                success = true;
                failureReason = '';
                diagnosticInfo = 'Already blocked or no record found.';
                throw new Error('SUCCESS_SKIP');
              }
            }
            // Clear input for new captcha text entry
            await page.fill('#captchaInput', '').catch(() => { });
            await page.waitForTimeout(1000);
          }
        }

        if (!mathSolved) {
          throw new Error('Failed to solve Math Verification CAPTCHA after 5 attempts.');
        }

        // Step 3: Block Execution Page
        console.log('[Execution] Force checking all row checkboxes natively...');
        await page.evaluate(() => {
          const rowBoxes = document.querySelectorAll('input[name="checkedArray"]');
          for (let box of rowBoxes) {
            box.checked = true;
          }
          const selectAllBox = document.querySelector('input[name="checkbox"]');
          if (selectAllBox) {
            selectAllBox.checked = true;
          }
        });
        await page.waitForTimeout(500);

        // Click Block (target specific block links or text, excluding menu items)
        console.log('[Execution] Clicking Block...');
        const blockButton = await page.$('a[onclick*="blockCellNumber"]') || await page.$('a:text-is("Block")');
        if (blockButton) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => { }),
            blockButton.evaluate(b => b.click())
          ]);
        } else {
          throw new Error('Block button not found on the execution page.');
        }

        // Wait for the confirmation/results page to load/settle
        await page.waitForTimeout(1000);
        console.log('[Execution] Waiting for block confirmation...');
        await page.waitForFunction(() => {
          const body = document.body;
          if (!body) return false;

          const okBtn = document.querySelector('a[href*="getView"], a[onclick*="getView"]') || Array.from(document.querySelectorAll('a')).find(a => a.innerText && a.innerText.trim() === 'Ok');
          if (okBtn && okBtn.getBoundingClientRect().width > 0) {
            return true;
          }

          const text = body.innerText || '';
          if (text.includes('Following Cell Number') || text.includes('Blocked') || text.includes('Error')) {
            return true;
          }
          return false;
        }, { timeout: 20000 });

        // Step 4: Block Confirmation Page Verification
        console.log('[Confirmation] Verifying block success text...');
        const pageText = await page.innerText('body');

        if (pageText.includes('Following Cell Number(s) are Blocked') && pageText.includes(number)) {
          success = true;
          failureReason = '';
          diagnosticInfo = `Successfully blocked number ${number}`;
          console.log(`[✓] Success - Blocked number ${number}`);
        } else if (pageText.toLowerCase().includes('already blocked') || pageText.toLowerCase().includes('already in use') || pageText.toLowerCase().includes('invalid status') || pageText.toLowerCase().includes('no record')) {
          success = true;
          failureReason = '';
          diagnosticInfo = `Number ${number} was already blocked.`;
          console.log(`[✓] Success - Number ${number} already blocked.`);
        } else {
          // Read any error layout in table cell
          const errorTds = await page.$$('td[bgcolor="#FF0000"]');
          let customErr = '';
          for (const td of errorTds) {
            customErr += (await td.innerText()) + ' ';
          }
          failureReason = customErr.trim() || 'Confirmation text not found on results page.';
          console.error(`[✗] Failed to block ${number}: ${failureReason}`);
        }

        // Click Ok to return to status check page for the next number
        console.log('[Confirmation] Clicking Ok to return to View page...');
        const okButton = await page.$('a[href*="getView"]') ||
          await page.$('a[onclick*="getView"]') ||
          await page.$('a:text-is("Ok")');
        if (okButton) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => { }),
            okButton.evaluate(b => b.click())
          ]);
        } else {
          throw new Error('Ok button not found on the confirmation page.');
        }

        // Wait for status check page to reload and settle
        await page.waitForTimeout(1000);
        console.log('[Confirmation] Waiting for status check page to reload...');
        const statusSelect = await page.waitForSelector('select[name="numberStatus"]', { timeout: 15000 }).catch(() => null);
        if (!statusSelect) {
          console.log('[Confirmation] Status check page did not reload automatically. Forcing navigation...');
          await page.goto(STATUS_VIEW_URL, { waitUntil: 'load', timeout: 20000 }).catch(() => { });
          await page.waitForTimeout(1000);
        }

      } catch (err) {
        if (err.message === 'SUCCESS_SKIP') {
          // Success skip requested, do nothing in catch block so it falls through to results.push
        } else {
          console.error(`[Error] Exception during blocking loop for ${number}:`, err.message);
          failureReason = err.message;
          diagnosticInfo = `Exception at step. Last math solution attempted: "${solvedMathText}"`;

          // Take an error screenshot to help with diagnostics
          try {
            const screenshotName = `error_${number}_${Date.now()}.png`;
            const screenshotPath = path.join(__dirname, '..', 'reports', screenshotName);
            await page.screenshot({ path: screenshotPath });
            console.log(`[Error Screenshot] Saved error screenshot for diagnostics: ${screenshotPath}`);
            diagnosticInfo = `Exception occurred. Screenshot saved to reports/${screenshotName}. Last math attempted: "${solvedMathText}"`;
          } catch (screenshotErr) {
            console.error('[Error Screenshot] Failed to capture diagnostic screenshot:', screenshotErr.message);
          }

          // Recover navigation: return to start status check page directly so next number doesn't break
          try {
            console.log('[Recovery] Navigating back to status check view page...');
            await page.goto(STATUS_VIEW_URL, { waitUntil: 'load', timeout: 20000 }).catch(() => { });
            await page.waitForTimeout(1000);
            await page.waitForSelector('select[name="numberStatus"]', { timeout: 10000 }).catch(() => { });
          } catch (recoverErr) {
            console.error('[Recovery] Failed to recover navigation path:', recoverErr.message);
          }
        }
      }

      const result = {
        number,
        status: success ? 'success' : 'failed',
        reason: failureReason,
        timestamp,
        diagnosticInfo
      };

      results.push(result);
      sendEvent({ type: 'result', ...result });

      // Delay between numbers
      await page.waitForTimeout(DELAY_BETWEEN_NUMBERS);
    }

    sendEvent({ type: 'done', results });
    console.log('[Done] Finished processing all numbers.');
    return results;

  } catch (err) {
    console.error('[Fatal Error] Automation crashed:', err.message);
    sendEvent({ type: 'error', message: err.message });
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { runAutomation };
