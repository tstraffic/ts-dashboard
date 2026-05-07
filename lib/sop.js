// SOP version + acknowledgement text.
// Bumping CURRENT_VERSION makes every existing acknowledgement "stale" so
// workers are re-prompted to sign on next portal login (gate added later).
const CURRENT_VERSION = 'v1-2026-05';

const ACKNOWLEDGEMENT_TEXT = `By signing below I confirm that:

• I have reviewed T&S Traffic Control's Standard Operating Procedures (SOPs).
• I have been adequately educated on traffic management procedures, PPE requirements and site safety.
• I understand and will comply with all SOPs, supervisor directions and client site rules whenever I perform work on behalf of T&S Traffic Control.
• I will report any unsafe condition, near miss or incident immediately.

I agree this electronic signature is legally binding under the Electronic Transactions Act 1999 (Cth).`;

function currentVersion() { return CURRENT_VERSION; }
function ackText() { return ACKNOWLEDGEMENT_TEXT; }

// Active SOP/SWMS documents in display order. The mobile sign page renders
// these above the signature pad; each must be ticked before the signature
// becomes active. Admin manages them at /induction/admin/sop-documents.
function activeDocuments(db) {
  return db.prepare(`
    SELECT id, title, filename, original_name, file_path, file_size, mime_type, display_order, created_at
    FROM sop_documents
    WHERE active = 1
    ORDER BY display_order ASC, id ASC
  `).all();
}

module.exports = { currentVersion, ackText, activeDocuments };
