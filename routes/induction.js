const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');

// Multer config for induction document uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'inductions');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const prefix = file.fieldname;
    cb(null, `${prefix}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp', '.heic', '.heif', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.avif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported. Please upload an image (JPG, PNG, HEIC) or PDF.'));
    }
  }
});

const uploadFields = upload.fields([
  { name: 'white_card_photo', maxCount: 1 },
  { name: 'tc_licence_photo', maxCount: 1 },
  { name: 'drivers_licence_photo', maxCount: 1 },
  { name: 'drivers_licence_back_photo', maxCount: 1 },
]);

// Valid payment types
const VALID_TYPES = ['cash', 'tfn', 'abn'];

// ─── LITERAL ROUTES FIRST (before /:type catches them) ───

// GET /induction — unified form
router.get('/', (req, res) => {
  const accessToken = crypto.randomBytes(24).toString('hex');
  res.render('induction/form', {
    layout: false,
    paymentType: 'unified',
    accessToken,
    title: 'T&S Induction'
  });
});

// GET /induction/complete — confirmation page
router.get('/complete', (req, res) => {
  res.render('induction/complete', {
    layout: false,
    paymentType: 'unified',
    title: 'Application Submitted'
  });
});

// POST /induction/submit — unified submit
router.post('/submit', (req, res) => {
  handleSubmission(req, res);
});

// ─── PARAMETRIC ROUTES (legacy URLs) ───

// GET /induction/:type — legacy URLs (cash, tfn, abn)
router.get('/:type', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();

  const accessToken = crypto.randomBytes(24).toString('hex');
  res.render('induction/form', {
    layout: false,
    paymentType: type,
    accessToken,
    title: 'T&S Induction'
  });
});

// GET /induction/:type/complete — legacy complete URLs
router.get('/:type/complete', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();

  res.render('induction/complete', {
    layout: false,
    paymentType: type,
    title: 'Application Submitted'
  });
});

// POST /induction/:type/submit — legacy submit URLs
router.post('/:type/submit', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();
  handleSubmission(req, res);
});

function handleSubmission(req, res) {
  uploadFields(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      // Show a friendly error page instead of raw JSON
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Upload Error | T&S Traffic Control</title>
          <script src="https://cdn.tailwindcss.com"><\/script>
          <script>tailwindcss.config={theme:{extend:{colors:{brand:{50:'#EBF3FF',100:'#D6E7FF',200:'#ADC9FF',500:'#2B7FFF',600:'#1D6AE5',700:'#1554CC',900:'#052A99'}}}}}<\/script>
        </head>
        <body class="min-h-screen bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 flex items-center justify-center p-4">
          <div class="bg-white rounded-2xl shadow-2xl p-8 md:p-10 max-w-md w-full text-center">
            <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-5">
              <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
              </svg>
            </div>
            <h1 class="text-xl font-bold text-gray-900 mb-2">Upload Error</h1>
            <p class="text-gray-600 mb-2">${err.message}</p>
            <p class="text-sm text-gray-400 mb-6">Accepted formats: JPG, PNG, HEIC, PDF, WebP</p>
            <button onclick="history.back()" class="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl transition shadow-md">
              Go Back & Try Again
            </button>
          </div>
        </body>
        </html>
      `);
    }

    try {
      const b = req.body;
      const paymentType = b.payment_type || req.params?.type || 'tfn';

      // Compute full_name from split fields (or use legacy field)
      const fn = (b.first_name || '').trim();
      const mn = (b.middle_name || '').trim();
      const ln = (b.last_name || '').trim();
      const computedFullName = [fn, mn, ln].filter(Boolean).join(' ') || (b.full_name || '').trim();

      // Get uploaded file paths
      const whiteCardPhoto = req.files?.white_card_photo?.[0]?.filename || '';
      const tcLicencePhoto = req.files?.tc_licence_photo?.[0]?.filename || '';
      const driversLicencePhoto = req.files?.drivers_licence_photo?.[0]?.filename || '';
      const driversLicenceBackPhoto = req.files?.drivers_licence_back_photo?.[0]?.filename || '';

      // For ABN contractors, bank fields have abn_ prefix to avoid form name conflicts
      if (paymentType === 'abn') {
        b.bank_name = b.abn_bank_name || b.bank_name || '';
        b.bank_bsb = b.abn_bank_bsb || b.bank_bsb || '';
        b.bank_account_number = b.abn_bank_account_number || b.bank_account_number || '';
        b.bank_account_name = b.abn_bank_account_name || b.bank_account_name || '';
      }
      // For cash workers, bank fields have cash_ prefix
      if (paymentType === 'cash') {
        b.bank_name = b.cash_bank_name || b.bank_name || '';
        b.bank_bsb = b.cash_bank_bsb || b.bank_bsb || '';
        b.bank_account_number = b.cash_bank_account_number || b.bank_account_number || '';
        b.bank_account_name = b.cash_bank_account_name || b.bank_account_name || '';
      }

      const stmt = getDb().prepare(`
        INSERT INTO induction_submissions (
          access_token, payment_type, status,
          full_name, first_name, middle_name, last_name,
          email, phone, date_of_birth,
          address, suburb, state, postcode,
          can_drive, can_drive_truck, has_injuries, injury_details, is_indigenous,
          white_card_number, tc_licence_number, tc_licence_date_of_issue, tc_licence_state,
          drivers_licence_number,
          white_card_photo, tc_licence_photo, drivers_licence_photo, drivers_licence_back_photo,
          experience_years, experience_description,
          tax_file_number, bank_name, bank_bsb, bank_account_number, bank_account_name,
          abn_number, has_insurance,
          super_fund_name, super_fund_abn, super_usi, super_member_number,
          company_intro_completed, ppe_acknowledged,
          submitted_at
        ) VALUES (
          ?, ?, 'submitted',
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          datetime('now')
        )
      `);

      stmt.run(
        b.access_token || crypto.randomBytes(24).toString('hex'),
        paymentType,
        computedFullName, fn, mn, ln,
        b.email || '', b.phone || '', b.date_of_birth || null,
        b.address || '', b.suburb || '', b.state || '', b.postcode || '',
        b.can_drive || '', b.can_drive_truck || '', b.has_injuries || '', b.injury_details || '', b.is_indigenous || '',
        b.white_card_number || '', b.tc_licence_number || '', b.tc_licence_date_of_issue || '', b.tc_licence_state || '',
        b.drivers_licence_number || '',
        whiteCardPhoto, tcLicencePhoto, driversLicencePhoto, driversLicenceBackPhoto,
        b.experience_years || '', b.experience_description || '',
        b.tax_file_number || '', b.bank_name || '', b.bank_bsb || '', b.bank_account_number || '', b.bank_account_name || '',
        b.abn_number || '', b.has_insurance || '',
        b.super_fund_name || '', b.super_fund_abn || '', b.super_usi || '', b.super_member_number || '',
        (b.company_intro_completed === 'on' || b.company_intro_completed === '1') ? 1 : 0,
        (b.ppe_acknowledged === 'on' || b.ppe_acknowledged === '1') ? 1 : 0
      );

      res.redirect('/induction/complete');
    } catch (error) {
      console.error('Induction submission error:', error);
      res.status(500).send('Something went wrong. Please try again.');
    }
  });
}

module.exports = router;
