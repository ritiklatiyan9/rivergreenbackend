// ─────────────────────────────────────────────────────────────────────────
// reminderNudge.service.js
//
// Sends an FCM "nudge" to each user who has pending follow-ups, scheduled
// calls, or overdue self-tasks. Fires every 3 hours during the working day:
// 7am, 10am, 1pm, 4pm, 7pm (Asia/Kolkata = local server time assumption).
// ─────────────────────────────────────────────────────────────────────────

import pool from '../config/db.js';
import fcmService from '../services/fcm.service.js';

const NUDGE_HOURS = [7, 10, 13, 16, 19]; // 5 fires/day, ~3h apart, 7am–7pm
const TICK_MS = 60 * 1000;               // wake every minute and check

let _intervalHandle = null;
let _lastFiredHour = null;
let _lastFiredDate = null;

const fmtDay = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/**
 * Build the per-user nudge payload by aggregating today's outstanding work.
 * Includes the names of the most overdue tasks so the FCM body actually
 * tells the user *what* to look at, not just a count.
 */
const collectPendingPerUser = async () => {
  const sql = `
    WITH followups_today AS (
      SELECT assigned_to AS user_id, COUNT(*)::int AS due_today
        FROM followups
       WHERE status = 'PENDING'
         AND scheduled_at::date <= CURRENT_DATE
       GROUP BY assigned_to
    ),
    overdue_followups AS (
      SELECT assigned_to AS user_id, COUNT(*)::int AS overdue
        FROM followups
       WHERE status = 'PENDING'
         AND scheduled_at < NOW() - INTERVAL '15 minutes'
       GROUP BY assigned_to
    ),
    overdue_self_tasks AS (
      SELECT t.created_by AS user_id,
             COUNT(*)::int AS overdue,
             (ARRAY_AGG(t.title ORDER BY t.current_due_date ASC))[1:2] AS sample_titles
        FROM admin_tasks t
       WHERE t.status NOT IN ('DONE', 'CANCELLED')
         AND t.current_due_date < CURRENT_DATE
       GROUP BY t.created_by
    ),
    overdue_supervision AS (
      SELECT st.assigned_to AS user_id,
             COUNT(*)::int AS overdue,
             (ARRAY_AGG(st.title ORDER BY st.due_date ASC))[1:2] AS sample_titles
        FROM supervision_tasks st
       WHERE st.status NOT IN ('COMPLETED')
         AND st.due_date IS NOT NULL
         AND st.due_date < CURRENT_DATE
       GROUP BY st.assigned_to
    )
    SELECT u.id AS user_id, u.role,
           COALESCE(ft.due_today, 0)            AS followups_due_today,
           COALESCE(of.overdue, 0)              AS followups_overdue,
           COALESCE(ot.overdue, 0)              AS tasks_overdue,
           COALESCE(os.overdue, 0)              AS supervision_overdue,
           ot.sample_titles                     AS task_titles,
           os.sample_titles                     AS supervision_titles
      FROM users u
      LEFT JOIN followups_today      ft ON ft.user_id = u.id
      LEFT JOIN overdue_followups    of ON of.user_id = u.id
      LEFT JOIN overdue_self_tasks   ot ON ot.user_id = u.id
      LEFT JOIN overdue_supervision  os ON os.user_id = u.id
     WHERE u.is_active = TRUE
       AND (
         COALESCE(ft.due_today, 0) > 0
         OR COALESCE(of.overdue, 0) > 0
         OR COALESCE(ot.overdue, 0) > 0
         OR COALESCE(os.overdue, 0) > 0
       )
  `;
  const { rows } = await pool.query(sql);
  return rows;
};

// Truncate a single task title so the FCM body stays readable on Android.
const trim = (s, n = 32) => {
  if (!s) return '';
  const str = String(s).trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Fold a list of titles into "First, Second" (+ "+N more" when applicable).
const formatTitles = (titles, total) => {
  const arr = Array.isArray(titles) ? titles.filter(Boolean).map(trim) : [];
  if (arr.length === 0) return '';
  const shown = arr.join(', ');
  const extra = Math.max(0, Number(total) - arr.length);
  return extra > 0 ? `${shown} +${extra} more` : shown;
};

const buildBody = (row) => {
  const parts = [];
  if (row.followups_overdue > 0) {
    parts.push(`${row.followups_overdue} overdue follow-up${row.followups_overdue > 1 ? 's' : ''}`);
  }
  if (row.followups_due_today > 0) {
    parts.push(`${row.followups_due_today} due today`);
  }
  if (row.tasks_overdue > 0) {
    const named = formatTitles(row.task_titles, row.tasks_overdue);
    parts.push(named ? `Tasks: ${named}` : `${row.tasks_overdue} task${row.tasks_overdue > 1 ? 's' : ''} overdue`);
  }
  if (row.supervision_overdue > 0) {
    const named = formatTitles(row.supervision_titles, row.supervision_overdue);
    parts.push(named ? `Supervision: ${named}` : `${row.supervision_overdue} supervision task${row.supervision_overdue > 1 ? 's' : ''} overdue`);
  }
  return parts.join(' · ');
};

const pickRoute = (row) => {
  // Most urgent first → land the user where they can act
  if (row.supervision_overdue > 0) return '/supervision-tasks';
  if (row.tasks_overdue > 0) return '/tasks';
  return '/calls/scheduled';
};

const fireNudges = async () => {
  let recipients = [];
  try {
    recipients = await collectPendingPerUser();
  } catch (e) {
    console.error('[nudge] Query failed:', e?.message || e);
    return;
  }
  if (!recipients.length) {
    console.log('[nudge] Nothing pending — skipping push.');
    return;
  }

  // Send one FCM per user with their personalised summary.
  let total = 0, ok = 0, fail = 0;
  for (const row of recipients) {
    const body = buildBody(row);
    if (!body) continue;
    total += 1;
    try {
      const res = await fcmService.sendToUsers([row.user_id], {
        title: 'Pending today',
        body,
        data: {
          type: 'reminder',
          route: pickRoute(row),
          followups_due_today: String(row.followups_due_today || 0),
          followups_overdue: String(row.followups_overdue || 0),
          tasks_overdue: String(row.tasks_overdue || 0),
          supervision_overdue: String(row.supervision_overdue || 0),
        },
      });
      ok += res?.sent ?? 0;
      fail += res?.failed ?? 0;
    } catch (e) {
      console.error(`[nudge] sendToUsers(${row.user_id}) failed:`, e?.message || e);
      fail += 1;
    }
  }
  console.log(`[nudge] cycle complete users=${total} sent=${ok} failed=${fail}`);
};

/**
 * Tick handler — every minute checks if we just crossed into a nudge hour
 * for the first time today. Cheap & idempotent across restarts within a
 * given cycle (won't re-fire after restart in the same hour).
 */
const tick = async () => {
  const now = new Date();
  const hour = now.getHours();
  const day = fmtDay(now);

  if (!NUDGE_HOURS.includes(hour)) return;
  if (_lastFiredDate === day && _lastFiredHour === hour) return;

  _lastFiredDate = day;
  _lastFiredHour = hour;
  console.log(`[nudge] firing for ${day} @${hour}:00`);
  await fireNudges();
};

export const startReminderNudge = () => {
  if (_intervalHandle) return;
  _intervalHandle = setInterval(() => {
    tick().catch((e) => console.error('[nudge] tick failed:', e?.message || e));
  }, TICK_MS);
  console.log(`[nudge] scheduler started — fires at ${NUDGE_HOURS.map((h) => `${h}:00`).join(', ')}`);
};

export const stopReminderNudge = () => {
  if (!_intervalHandle) return;
  clearInterval(_intervalHandle);
  _intervalHandle = null;
};

// Exposed for ops/manual debugging via a route or REPL.
export const fireReminderNudgeNow = fireNudges;
