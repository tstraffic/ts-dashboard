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
    const prefix = file.fieldname; // white_card_photo, tc_licence_photo, drivers_licence_photo
    cb(null, `${prefix}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs are allowed'));
    }
  }
});

const uploadFields = upload.fields([
  { name: 'white_card_photo', maxCount: 1 },
  { name: 'tc_licence_photo', maxCount: 1 },
  { name: 'drivers_licence_photo', maxCount: 1 },
]);

// Valid payment types
const VALID_TYPES = ['cash', 'tfn', 'abn'];

// GET /induction/:type — render the soft induction form
router.get('/:type', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) {
    return next();
  }

  const accessToken = crypto.randomBytes(24).toString('hex');

  res.render('induction/form', {
    layout: false,
    paymentType: type,
    accessToken,
    title: 'T&S Induction'
  });
});

// POST /induction/:type/submit — process the soft induction form
router.post('/:type/submit', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();
  uploadFields(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message });
    }

    try {
      const {
        access_token,
        full_name, email, phone, date_of_birth,
        address, suburb, state, postcode,
        can_drive, can_drive_truck, has_injuries, injury_details, is_indigenous,
        white_card_number, tc_licence_number, drivers_licence_number,
        tax_file_number, bank_bsb, bank_account_number, bank_account_name,
        abn_number,
        company_intro_completed, ppe_acknowledged
      } = req.body;

      // Get uploaded file paths
      const whiteCardPhoto = req.files?.white_card_photo?.[0]?.filename || '';
      const tcLicencePhoto = req.files?.tc_licence_photo?.[0]?.filename || '';
      const driversLicencePhoto = req.files?.drivers_licence_photo?.[0]?.filename || '';

      const stmt = getDb().prepare(`
        INSERT INTO induction_submissions (
          access_token, payment_type, status,
          full_name, email, phone, date_of_birth,
          address, suburb, state, postcode,
          can_drive, can_drive_truck, has_injuries, injury_details, is_indigenous,
          white_card_number, tc_licence_number, drivers_licence_number,
          white_card_photo, tc_licence_photo, drivers_licence_photo,
          tax_file_number, bank_bsb, bank_account_number, bank_account_name,
          abn_number,
          company_intro_completed, ppe_acknowledged,
          submitted_at
        ) VALUES (
          ?, ?, 'submitted',
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?,
          ?, ?,
          datetime('now')
        )
      `);

      stmt.run(
        access_token || crypto.randomBytes(24).toString('hex'),
        type,
        full_name || '', email || '', phone || '', date_of_birth || null,
        address || '', suburb || '', state || '', postcode || '',
        can_drive || '', can_drive_truck || '', has_injuries || '', injury_details || '', is_indigenous || '',
        white_card_number || '', tc_licence_number || '', drivers_licence_number || '',
        whiteCardPhoto, tcLicencePhoto, driversLicencePhoto,
        tax_file_number || '', bank_bsb || '', bank_account_number || '', bank_account_name || '',
        abn_number || '',
        company_intro_completed === 'on' || company_intro_completed === '1' ? 1 : 0,
        ppe_acknowledged === 'on' || ppe_acknowledged === '1' ? 1 : 0
      );

      res.redirect(`/induction/${type}/complete`);
    } catch (error) {
      console.error('Induction submission error:', error);
      res.status(500).send('Something went wrong. Please try again.');
    }
  });
});

// GET /induction/:type/complete — confirmation page
router.get('/:type/complete', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) {
    return next();
  }

  res.render('induction/complete', {
    layout: false,
    paymentType: type,
    title: 'Application Submitted'
  });
});

module.exports = router;
