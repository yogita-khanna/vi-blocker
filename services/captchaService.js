const Tesseract = require('tesseract.js');

/**
 * Solves a mathematical expression (e.g. "75 + 78 = ?")
 * @param {string} text 
 * @returns {string|null}
 */
function solveMathExpression(text) {
  // Normalize multiplication operators: replace x or X with *
  let cleaned = text.replace(/x/gi, '*').replace(/\s+/g, '');
  // If there's an equals sign, discard everything after it to avoid parsing issues with ? or other symbols
  if (cleaned.includes('=')) {
    cleaned = cleaned.split('=')[0];
  }
  // Match the first math pattern: [digits][operator][digits]
  const match = cleaned.match(/(\d+)([+\-*/])(\d+)/);
  if (match) {
    const a = parseInt(match[1], 10);
    const op = match[2];
    const b = parseInt(match[3], 10);
    let result;
    switch (op) {
      case '+': result = a + b; break;
      case '-': result = a - b; break;
      case '*': result = a * b; break;
      case '/': result = Math.round(a / b); break;
      default: return null;
    }
    console.log(`[CAPTCHA Solver] Parsed expression "${a} ${op} ${b}" and solved: ${result}`);
    return String(result);
  }
  return null;
}

/**
 * Solve captcha using local free Tesseract OCR engine
 * @param {Buffer} imageBuffer 
 * @param {Object} options - { isMath: boolean }
 * @returns {Promise<string>}
 */
async function solveCaptcha(imageBuffer, options = { isMath: false }) {
  try {
    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng', {
      logger: () => {} // suppress verbose tesseract console logs
    });

    if (options.isMath) {
      // Normalize common OCR typos for operators before filtering
      let preCleaned = text.replace(/\s+/g, ' ');
      // Replace 't' or 'T' with '+' if between digits (e.g. "75 t 78")
      preCleaned = preCleaned.replace(/(\d+)\s*[tT]\s*(\d+)/g, '$1+$2');
      // Replace 'x' or 'X' with '*'
      preCleaned = preCleaned.replace(/(\d+)\s*[xX]\s*(\d+)/g, '$1*$2');
      // Replace '_' or '~' with '-'
      preCleaned = preCleaned.replace(/(\d+)\s*[_~]\s*(\d+)/g, '$1-$2');
      // Replace '|' or '\' with '/'
      preCleaned = preCleaned.replace(/(\d+)\s*[|\\]\s*(\d+)/g, '$1/$2');

      // For math captcha: keep numbers, operators, and equals
      const cleaned = preCleaned.replace(/[^0-9+\-*/=]/g, '').trim();
      console.log(`[CAPTCHA] Tesseract Math OCR read (cleaned): "${cleaned}"`);
      const mathResult = solveMathExpression(cleaned);
      if (mathResult !== null) {
        return mathResult;
      }
      return cleaned;
    }

    // For login captcha: alphanumeric characters only
    const cleaned = text.replace(/[^a-zA-Z0-9]/g, '').trim();
    console.log(`[CAPTCHA] Tesseract Login OCR read: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    console.error('[CAPTCHA] Local Tesseract solving failed:', err.message);
    throw err;
  }
}

module.exports = { solveCaptcha };
