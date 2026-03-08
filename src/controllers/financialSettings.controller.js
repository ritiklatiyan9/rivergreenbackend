import asyncHandler from '../utils/asyncHandler.js';
import financialSettingsModel from '../models/FinancialSettings.model.js';
import pool from '../config/db.js';
import { uploadSingle } from '../utils/upload.js';

// ============================================================
// GET FINANCIAL SETTINGS (for admin's site)
// ============================================================
export const getFinancialSettings = asyncHandler(async (req, res) => {
  const siteId = req.user.site_id;
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const settings = await financialSettingsModel.findBySite(siteId, pool);
  res.json({ success: true, settings: settings || null });
});

// ============================================================
// UPDATE FINANCIAL SETTINGS (upsert for admin's site)
// ============================================================
export const updateFinancialSettings = asyncHandler(async (req, res) => {
  const siteId = req.user.site_id;
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const {
    bank_name, account_holder_name, account_number, ifsc_code, bank_branch,
    upi_id, payment_instructions,
  } = req.body;

  // Handle UPI Scanner image upload
  let upi_scanner_url = req.body.upi_scanner_url;
  if (req.file) {
    const result = await uploadSingle(req.file, 's3');
    upi_scanner_url = result.secure_url;
  }

  const data = {
    bank_name: bank_name || null,
    account_holder_name: account_holder_name || null,
    account_number: account_number || null,
    ifsc_code: ifsc_code || null,
    bank_branch: bank_branch || null,
    upi_id: upi_id || null,
    upi_scanner_url: upi_scanner_url || null,
    payment_instructions: payment_instructions || null,
    updated_by: req.user.id,
    created_by: req.user.id,
  };

  const settings = await financialSettingsModel.upsert(siteId, data, pool);
  res.json({ success: true, settings, message: 'Financial settings updated' });
});

// ============================================================
// GET PUBLIC FINANCIAL SETTINGS (for public booking page - by site_id)
// ============================================================
export const getPublicFinancialSettings = asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  if (!siteId) {
    return res.status(400).json({ success: false, message: 'Site ID is required' });
  }

  const settings = await financialSettingsModel.findBySite(siteId, pool);
  if (!settings) {
    return res.json({ success: true, settings: null });
  }

  // Return only public-safe fields
  res.json({
    success: true,
    settings: {
      bank_name: settings.bank_name,
      account_holder_name: settings.account_holder_name,
      account_number: settings.account_number,
      ifsc_code: settings.ifsc_code,
      bank_branch: settings.bank_branch,
      upi_id: settings.upi_id,
      upi_scanner_url: settings.upi_scanner_url,
      payment_instructions: settings.payment_instructions,
    },
  });
});
