/**
 * Email Utility — Send emails via SMTP using nodemailer.
 * SMTP config is loaded from the system_config table.
 */
const nodemailer = require('nodemailer');
const { getConfig } = require('./settings');

let _transporter = null;

/**
 * Get or create the nodemailer transporter using system_config SMTP settings.
 * Returns null if SMTP is not configured.
 */
function getTransporter() {
  const host = getConfig('smtp_host', '');
  const port = parseInt(getConfig('smtp_port', '587'), 10);
  const user = getConfig('smtp_user', '');
  const pass = getConfig('smtp_pass', '');

  if (!host || !user) {
    return null; // SMTP not configured
  }

  // Re-create transporter if config might have changed
  _transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });

  return _transporter;
}

/**
 * Send an email. Fails silently if SMTP is not configured.
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - Email body (HTML)
 */
async function sendEmail(to, subject, html) {
  try {
    const transporter = getTransporter();
    if (!transporter) {
      console.log('[Email] SMTP not configured — skipping email to', to);
      return false;
    }

    const from = getConfig('smtp_from', 'noreply@tstraffic.com.au');

    await transporter.sendMail({
      from: `"T&S Operations" <${from}>`,
      to,
      subject,
      html,
    });

    console.log('[Email] Sent:', subject, '→', to);
    return true;
  } catch (err) {
    console.error('[Email] Failed to send:', err.message);
    return false;
  }
}

/**
 * Send a task assignment email to the task owner.
 * @param {object} taskData - { title, description, due_date, priority, task_type, id }
 * @param {object} ownerUser - { full_name, email }
 * @param {string} jobLabel - e.g. "J-02451 - ABC Civil"
 * @param {string} assignedByName - Name of who assigned/created
 * @param {string} baseUrl - e.g. "http://localhost:3000"
 */
async function sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, assignedByName, baseUrl) {
  if (!ownerUser || !ownerUser.email) return false;

  const priorityColors = { high: '#EF4444', medium: '#F59E0B', low: '#9CA3AF' };
  const priorityColor = priorityColors[taskData.priority] || '#9CA3AF';
  const priorityLabel = (taskData.priority || 'medium').charAt(0).toUpperCase() + (taskData.priority || 'medium').slice(1);
  const dueDate = taskData.due_date ? new Date(taskData.due_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'No due date';
  const taskUrl = baseUrl + '/tasks/' + taskData.id + '/edit';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background: #2B7FFF; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: white; margin: 0; font-size: 18px;">T&S Operations Dashboard</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
        <p style="color: #374151; margin: 0 0 16px;">Hi <strong>${ownerUser.full_name}</strong>,</p>
        <p style="color: #6B7280; margin: 0 0 20px; font-size: 14px;">A task has been assigned to you${assignedByName ? ' by <strong>' + assignedByName + '</strong>' : ''}:</p>

        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: #111827; margin: 0 0 8px; font-size: 16px;">${taskData.title}</h3>
          ${taskData.description ? '<p style="color: #9CA3AF; margin: 0 0 12px; font-size: 13px;">' + taskData.description + '</p>' : ''}
          <table style="width: 100%; font-size: 13px; color: #6B7280;">
            <tr>
              <td style="padding: 4px 0;"><strong>Project:</strong></td>
              <td style="padding: 4px 0;">${jobLabel}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0;"><strong>Due Date:</strong></td>
              <td style="padding: 4px 0;">${dueDate}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0;"><strong>Priority:</strong></td>
              <td style="padding: 4px 0;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${priorityColor};margin-right:6px;"></span>${priorityLabel}</td>
            </tr>
          </table>
        </div>

        <div style="text-align: center;">
          <a href="${taskUrl}" style="display: inline-block; background: #2B7FFF; color: white; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Task</a>
        </div>

        <p style="color: #9CA3AF; font-size: 12px; margin: 20px 0 0; text-align: center;">T&S Traffic Control Operations Dashboard</p>
      </div>
    </div>
  `;

  return sendEmail(ownerUser.email, 'Task Assigned: ' + taskData.title, html);
}

/**
 * Send a task status change email to the task owner.
 */
async function sendTaskStatusEmail(taskData, ownerUser, newStatus, changedByName, baseUrl) {
  if (!ownerUser || !ownerUser.email) return false;

  const statusLabels = { not_started: 'Not Started', in_progress: 'In Progress', blocked: 'Blocked', complete: 'Complete' };
  const statusLabel = statusLabels[newStatus] || newStatus;
  const taskUrl = baseUrl + '/tasks/' + taskData.id + '/edit';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background: #2B7FFF; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: white; margin: 0; font-size: 18px;">T&S Operations Dashboard</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
        <p style="color: #374151; margin: 0 0 16px;">Hi <strong>${ownerUser.full_name}</strong>,</p>
        <p style="color: #6B7280; margin: 0 0 20px; font-size: 14px;">The status of your task has been updated${changedByName ? ' by <strong>' + changedByName + '</strong>' : ''}:</p>

        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: #111827; margin: 0 0 8px; font-size: 16px;">${taskData.title}</h3>
          <p style="color: #6B7280; font-size: 14px; margin: 0;">New Status: <strong>${statusLabel}</strong></p>
        </div>

        <div style="text-align: center;">
          <a href="${taskUrl}" style="display: inline-block; background: #2B7FFF; color: white; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Task</a>
        </div>

        <p style="color: #9CA3AF; font-size: 12px; margin: 20px 0 0; text-align: center;">T&S Traffic Control Operations Dashboard</p>
      </div>
    </div>
  `;

  return sendEmail(ownerUser.email, 'Task Update: ' + taskData.title + ' — ' + statusLabel, html);
}

module.exports = { sendEmail, sendTaskAssignmentEmail, sendTaskStatusEmail };
