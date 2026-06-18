const XLSX = require('xlsx');

function readPhoneNumbers(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0]; // reads first sheet
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  // Looks for a column named "phone_number" (case-insensitive)
  const numbers = rows.map(row => {
    const key = Object.keys(row).find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('number') || k.toLowerCase().includes('mobile'));
    if (!key) return null;

    let val = String(row[key]).trim();
    
    // Handle floating numbers or scientific notation parsed from Excel (e.g. 9876543210.0 or 9.87e+09)
    if (val.includes('.') && !isNaN(val)) {
      val = String(Math.round(parseFloat(val)));
    }

    // Keep only digits
    let num = val.replace(/\D/g, '');

    // Standardize to 10 digits for Indian mobile numbers
    if (num.length > 10) {
      if (num.length === 12 && num.startsWith('91')) {
        num = num.slice(2);
      } else {
        num = num.slice(-10);
      }
    }

    return num.length === 10 ? num : null;
  }).filter(Boolean);

  console.log(`[Excel] Found ${numbers.length} valid 10-digit phone numbers`);
  return numbers;
}

const fs = require('fs');
const path = require('path');

function generateReport(results) {
  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Format data for sheet
  const data = results.map((r, index) => ({
    'Index': index + 1,
    'Phone Number': r.number,
    'Status': r.status === 'success' ? '✅ Success' : '❌ Failed',
    'Failure Reason': r.reason || '-',
    'Timestamp': r.timestamp,
    'Diagnostic Info': r.diagnosticInfo || '-'
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Blocking Report');

  // Set column widths for better readability
  const max_widths = [
    { wch: 8 },  // Index
    { wch: 15 }, // Phone Number
    { wch: 12 }, // Status
    { wch: 35 }, // Failure Reason
    { wch: 28 }, // Timestamp
    { wch: 45 }  // Diagnostic Info
  ];
  worksheet['!cols'] = max_widths;

  const filename = `block_report_${Date.now()}.xlsx`;
  const filePath = path.join(reportsDir, filename);
  XLSX.writeFile(workbook, filePath);

  console.log(`[Excel] Report generated successfully at: ${filePath}`);
  return filename;
}

module.exports = { readPhoneNumbers, generateReport };

