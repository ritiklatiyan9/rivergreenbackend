import asyncHandler from '../utils/asyncHandler.js';
import financialSettingsModel from '../models/FinancialSettings.model.js';
import pool from '../config/db.js';
import { uploadSingle } from '../utils/upload.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// Resolve "Defence Garden Phase 2" (or any name) to its colony_map_id within the
// admin's site. Returns null when name is empty or no match.
const resolveColonyByName = async (siteId, colonyName) => {
  if (!colonyName) return null;
  const r = await pool.query(
    'SELECT id FROM colony_maps WHERE site_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
    [siteId, String(colonyName).trim()]
  );
  return r.rows[0]?.id || null;
};

// Validate that a colony belongs to this site (prevents cross-site writes).
const ensureColonyInSite = async (siteId, colonyMapId) => {
  if (!colonyMapId) return true;
  const r = await pool.query(
    'SELECT 1 FROM colony_maps WHERE id = $1 AND site_id = $2',
    [colonyMapId, siteId]
  );
  return r.rowCount > 0;
};

// ============================================================
// GET FINANCIAL SETTINGS (admin)
//   - ?colony_map_id=<uuid>  → that colony's row (or null if not yet saved)
//   - no param               → site-wide default row (colony_map_id IS NULL)
// ============================================================
export const getFinancialSettings = asyncHandler(async (req, res) => {
  const siteId = req.user.site_id;
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const { colony_map_id } = req.query;
  if (colony_map_id) {
    const ok = await ensureColonyInSite(siteId, colony_map_id);
    if (!ok) return res.status(404).json({ success: false, message: 'Colony not found' });
    const settings = await financialSettingsModel.findByColony(siteId, colony_map_id, pool);
    return res.json({ success: true, settings: settings || null });
  }

  const settings = await financialSettingsModel.findBySite(siteId, pool);
  res.json({ success: true, settings: settings || null });
});

// ============================================================
// LIST FINANCIAL SETTINGS (admin) — site default + every per-colony override
// ============================================================
export const listFinancialSettings = asyncHandler(async (req, res) => {
  const siteId = req.user.site_id;
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const rows = await financialSettingsModel.listBySite(siteId, pool);
  res.json({ success: true, settings: rows });
});

// ============================================================
// UPDATE FINANCIAL SETTINGS (admin upsert)
//   body.colony_map_id (optional UUID) — null/missing means site-wide default.
// ============================================================
export const updateFinancialSettings = asyncHandler(async (req, res) => {
  const siteId = req.user.site_id;
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const {
    colony_map_id,
    bank_name, account_holder_name, account_number, ifsc_code, bank_branch,
    upi_id, payment_instructions,
    razorpay_key_id, razorpay_key_secret, default_booking_amount,
  } = req.body;

  const colonyId = colony_map_id && colony_map_id !== '' ? colony_map_id : null;
  if (colonyId) {
    const ok = await ensureColonyInSite(siteId, colonyId);
    if (!ok) return res.status(404).json({ success: false, message: 'Colony not found' });
  }

  // Multer .fields() exposes req.files keyed by field name, each an array.
  const upiFile = req.files?.upi_scanner?.[0] || null;
  const colonyFile = req.files?.colony_image?.[0] || null;

  let upi_scanner_url = req.body.upi_scanner_url;
  if (upiFile) {
    const result = await uploadSingle(upiFile, 's3');
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
    razorpay_key_id: razorpay_key_id || null,
    razorpay_key_secret: razorpay_key_secret || null,
    default_booking_amount: default_booking_amount ? parseFloat(default_booking_amount) : 0,
    updated_by: req.user.id,
    created_by: req.user.id,
  };

  // Only touch colony_image_url when we have an explicit directive (new
  // upload or removal). Omitting it leaves the existing value intact, so a
  // save that doesn't change the image won't accidentally clear it.
  if (colonyFile) {
    const result = await uploadSingle(colonyFile, 's3');
    data.colony_image_url = result.secure_url;
  } else if (req.body.remove_colony_image === 'true') {
    data.colony_image_url = null;
  }

  const settings = await financialSettingsModel.upsert(siteId, colonyId, data, pool);
  res.json({ success: true, settings, message: 'Financial settings updated' });
  bustCache('cache:*:/api/financial-settings*');
  bustCache('cache:*:/api/razorpay*');
});

// ============================================================
// GET PUBLIC FINANCIAL SETTINGS (public — SharedPlot, public maps)
//   - ?colony_name=<name>  → effective settings for that colony (per-colony if
//     present, else site default)
//   - no param             → site default
// ============================================================
export const getPublicFinancialSettings = asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  if (!siteId) return res.status(400).json({ success: false, message: 'Site ID is required' });

  const colonyMapId = await resolveColonyByName(siteId, req.query.colony_name);
  const settings = colonyMapId
    ? await financialSettingsModel.findEffective(siteId, colonyMapId, pool)
    : await financialSettingsModel.findBySite(siteId, pool);

  if (!settings) return res.json({ success: true, settings: null });

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
      default_booking_amount: parseFloat(settings.default_booking_amount) || 0,
    },
  });
});
