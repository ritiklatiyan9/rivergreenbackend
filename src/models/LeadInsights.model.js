// Aggregates are calculated over the entire permitted portfolio, never a page
// of lead rows. Group each activity table before combining it to avoid fan-out.
export async function getLeadInsights({ siteId, viewerId, agentId, days, status, category, search }, db) {
  const result = await db.query(`
    WITH scoped_leads AS MATERIALIZED (
      SELECT l.* FROM leads l
      WHERE l.site_id = $1::uuid
        AND ($2::uuid IS NULL OR l.owner_id = $2 OR l.assigned_to = $2)
        AND ($3::uuid IS NULL OR l.assigned_to = $3)
        AND ($5::text IS NULL OR l.status = $5)
        AND ($6::text IS NULL OR l.lead_category = $6)
        AND ($7::text IS NULL OR l.name ILIKE $7 OR l.phone ILIKE $7 OR l.email ILIKE $7)
    ), contact_history AS MATERIALIZED (
      SELECT c.lead_id, COUNT(*)::int AS call_count,
        COUNT(*) FILTER (WHERE c.duration_seconds > 0)::int AS connected,
        MAX(c.call_start) AS last_call_at
      FROM calls c JOIN scoped_leads l ON l.id = c.lead_id
      WHERE c.site_id = $1 GROUP BY c.lead_id
    ), period_calls AS MATERIALIZED (
      SELECT c.* FROM calls c JOIN scoped_leads l ON l.id = c.lead_id
      WHERE c.site_id = $1
        AND c.call_start >= CURRENT_DATE - ($4::int - 1) * INTERVAL '1 day'
        AND c.call_start <= NOW()
        AND ($3::uuid IS NULL OR c.assigned_to = $3)
        AND ($2::uuid IS NULL OR c.assigned_to = $2)
    ), scoped_followups AS MATERIALIZED (
      SELECT f.* FROM followups f JOIN scoped_leads l ON l.id = f.lead_id
      WHERE f.site_id = $1
    ), followup_health AS (
      SELECT lead_id,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'SNOOZED') AND scheduled_at < NOW())::int AS overdue,
        MIN(scheduled_at) FILTER (WHERE status IN ('PENDING', 'SNOOZED') AND scheduled_at >= NOW()) AS next_followup
      FROM scoped_followups GROUP BY lead_id
    ), portfolio AS MATERIALIZED (
      SELECT l.*, COALESCE(c.call_count, 0) AS call_count,
        COALESCE(c.connected, 0) AS connected, c.last_call_at,
        COALESCE(f.overdue, 0) AS overdue, f.next_followup,
        COALESCE(c.last_call_at, l.created_at) < NOW() - INTERVAL '7 days' AS stale
      FROM scoped_leads l
      LEFT JOIN contact_history c ON c.lead_id = l.id
      LEFT JOIN followup_health f ON f.lead_id = l.id
    ), lead_agents AS (
      SELECT assigned_to AS agent_id, COUNT(*)::int AS leads,
        COUNT(*) FILTER (WHERE status = 'BOOKED')::int AS booked,
        COUNT(*) FILTER (WHERE call_count = 0)::int AS untouched,
        COUNT(*) FILTER (WHERE overdue > 0)::int AS overdue_leads
      FROM portfolio GROUP BY assigned_to
    ), call_agents AS (
      SELECT assigned_to AS agent_id, COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE duration_seconds > 0)::int AS connected,
        COALESCE(SUM(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::bigint AS talk_seconds,
        COUNT(DISTINCT call_start::date)::int AS active_days,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(customer_notes), '') IS NOT NULL)::int AS documented
      FROM period_calls GROUP BY assigned_to
    ), agent_ids AS (
      SELECT agent_id FROM lead_agents UNION SELECT agent_id FROM call_agents
    )
    SELECT
      (SELECT JSONB_BUILD_OBJECT(
        'total', COUNT(*), 'new', COUNT(*) FILTER (WHERE status = 'NEW'),
        'booked', COUNT(*) FILTER (WHERE status = 'BOOKED'),
        'untouched', COUNT(*) FILTER (WHERE call_count = 0),
        'connectedLeads', COUNT(*) FILTER (WHERE connected > 0),
        'stale', COUNT(*) FILTER (WHERE stale AND status NOT IN ('BOOKED', 'LOST', 'NOT_INTERESTED')),
        'overdueLeads', COUNT(*) FILTER (WHERE overdue > 0),
        'unassigned', COUNT(*) FILTER (WHERE assigned_to IS NULL),
        'highIntent', COUNT(*) FILTER (WHERE lead_category IN ('PRIME', 'HOT') AND status NOT IN ('BOOKED', 'LOST', 'NOT_INTERESTED'))
      ) FROM portfolio) AS portfolio,
      (SELECT JSONB_BUILD_OBJECT(
        'calls', COUNT(*), 'connected', COUNT(*) FILTER (WHERE duration_seconds > 0),
        'uniqueLeads', COUNT(DISTINCT lead_id),
        'talkSeconds', COALESCE(SUM(duration_seconds) FILTER (WHERE duration_seconds > 0), 0),
        'avgConnectedSeconds', AVG(duration_seconds) FILTER (WHERE duration_seconds > 0),
        'documented', COUNT(*) FILTER (WHERE NULLIF(BTRIM(customer_notes), '') IS NOT NULL),
        'activeDays', COUNT(DISTINCT call_start::date)
      ) FROM period_calls) AS activity,
      (SELECT JSONB_BUILD_OBJECT(
        'due', COUNT(*), 'completed', COUNT(*) FILTER (WHERE status = 'COMPLETED'),
        'overdue', COUNT(*) FILTER (WHERE status IN ('PENDING', 'SNOOZED') AND scheduled_at < NOW())
      ) FROM scoped_followups
        WHERE scheduled_at >= CURRENT_DATE - ($4::int - 1) * INTERVAL '1 day' AND scheduled_at <= NOW()
          AND ($3::uuid IS NULL OR assigned_to = $3) AND ($2::uuid IS NULL OR assigned_to = $2)
      ) AS followups,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.count DESC), '[]') FROM (
        SELECT COALESCE(status, 'UNKNOWN') AS label, COUNT(*)::int AS count FROM portfolio GROUP BY status
      ) s) AS statuses,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.count DESC), '[]') FROM (
        SELECT COALESCE(NULLIF(lead_source, ''), 'Unknown') AS label, COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE status = 'BOOKED')::int AS booked
        FROM portfolio GROUP BY COALESCE(NULLIF(lead_source, ''), 'Unknown')
      ) s) AS sources,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.date), '[]') FROM (
        SELECT call_start::date::text AS date, COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE duration_seconds > 0)::int AS connected
        FROM period_calls GROUP BY call_start::date
      ) s) AS daily,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.count DESC), '[]') FROM (
        SELECT COALESCE(o.label, 'No outcome recorded') AS label, COUNT(*)::int AS count
        FROM period_calls c LEFT JOIN call_outcomes o ON o.id = c.outcome_id
        GROUP BY COALESCE(o.label, 'No outcome recorded') ORDER BY count DESC LIMIT 8
      ) s) AS outcomes,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.calls DESC, s.name), '[]') FROM (
        SELECT u.id, u.name, u.role, COALESCE(l.leads, 0) AS leads, COALESCE(l.booked, 0) AS booked,
          COALESCE(l.untouched, 0) AS untouched, COALESCE(l.overdue_leads, 0) AS overdue_leads,
          COALESCE(c.calls, 0) AS calls, COALESCE(c.connected, 0) AS connected,
          COALESCE(c.talk_seconds, 0) AS talk_seconds, COALESCE(c.active_days, 0) AS active_days,
          COALESCE(c.documented, 0) AS documented
        FROM agent_ids ids JOIN users u ON u.id = ids.agent_id
        LEFT JOIN lead_agents l ON l.agent_id = u.id LEFT JOIN call_agents c ON c.agent_id = u.id
        WHERE ($2::uuid IS NULL OR u.id = $2) AND ($3::uuid IS NULL OR u.id = $3)
        ORDER BY calls DESC, u.name LIMIT 50
      ) s) AS agents,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.overdue DESC, s.last_call_at NULLS FIRST, s.created_at), '[]') FROM (
        SELECT p.id, p.name, p.phone, p.status, p.lead_category, p.assigned_to,
          u.name AS assigned_to_name, p.call_count, p.last_call_at, p.created_at,
          p.overdue, p.next_followup,
          CASE WHEN p.overdue > 0 THEN 'Overdue follow-up' WHEN p.call_count = 0 THEN 'No calls recorded' ELSE 'No call in 7+ days' END AS reason
        FROM portfolio p LEFT JOIN users u ON u.id = p.assigned_to
        WHERE p.status NOT IN ('BOOKED', 'LOST', 'NOT_INTERESTED') AND (p.overdue > 0 OR p.call_count = 0 OR p.stale)
        ORDER BY p.overdue DESC, p.last_call_at NULLS FIRST, p.created_at LIMIT 8
      ) s) AS attention
  `, [siteId, viewerId, agentId, days, status, category, search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null]);
  return result.rows[0];
}

export async function getClientInsights(leadId, siteId, db) {
  const result = await db.query(`
    WITH lead_calls AS MATERIALIZED (
      SELECT c.* FROM calls c WHERE c.lead_id = $1::uuid AND c.site_id = $2::uuid
    ), lead_followups AS MATERIALIZED (
      SELECT f.* FROM followups f WHERE f.lead_id = $1 AND f.site_id = $2
    ), events AS (
      SELECT 'call'::text AS type, c.id::text AS id, c.call_start AS occurred_at,
        COALESCE(o.label, 'Call recorded') AS title, c.customer_notes AS notes,
        u.name AS agent, JSONB_BUILD_OBJECT('duration', c.duration_seconds, 'call_type', c.call_type, 'next_action', c.next_action) AS details
      FROM lead_calls c LEFT JOIN users u ON u.id = c.assigned_to LEFT JOIN call_outcomes o ON o.id = c.outcome_id
      UNION ALL
      SELECT 'followup', f.id::text, f.created_at, 'Follow-up created', f.notes,
        u.name, JSONB_BUILD_OBJECT('scheduled_at', f.scheduled_at, 'type', f.followup_type, 'status', f.status)
      FROM lead_followups f LEFT JOIN users u ON u.id = f.assigned_to
      UNION ALL
      SELECT 'assignment', a.id::text, a.created_at, 'Lead reassigned', a.reason, u.name,
        JSONB_BUILD_OBJECT('from', previous.name, 'to', next_agent.name)
      FROM lead_assignments a
      JOIN leads scoped ON scoped.id = a.lead_id AND scoped.site_id = $2
      LEFT JOIN users u ON u.id = a.assigned_by LEFT JOIN users previous ON previous.id = a.assigned_from
      LEFT JOIN users next_agent ON next_agent.id = a.assigned_to WHERE a.lead_id = $1
    )
    SELECT
      (SELECT JSONB_BUILD_OBJECT('calls', COUNT(*), 'connected', COUNT(*) FILTER (WHERE duration_seconds > 0),
        'talkSeconds', COALESCE(SUM(duration_seconds) FILTER (WHERE duration_seconds > 0), 0),
        'firstCallAt', MIN(call_start), 'lastCallAt', MAX(call_start),
        'agents', COUNT(DISTINCT assigned_to)) FROM lead_calls) AS engagement,
      (SELECT JSONB_BUILD_OBJECT('total', COUNT(*), 'completed', COUNT(*) FILTER (WHERE status = 'COMPLETED'),
        'overdue', COUNT(*) FILTER (WHERE status IN ('PENDING', 'SNOOZED') AND scheduled_at < NOW()),
        'nextAt', MIN(scheduled_at) FILTER (WHERE status IN ('PENDING', 'SNOOZED') AND scheduled_at >= NOW())) FROM lead_followups) AS followups,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.call_start DESC), '[]') FROM (
        SELECT call_start, customer_notes,
          TO_JSONB(c)->>'buying_timeline' AS buying_timeline,
          TO_JSONB(c)->>'budget_confirmation' AS budget_confirmation,
          TO_JSONB(c)->>'specific_requests' AS specific_requests
          , TO_JSONB(c)->>'customer_words' AS customer_words
          , TO_JSONB(c)->>'rejection_reason' AS rejection_reason
          , TO_JSONB(c)->>'visit_preference_date' AS visit_preference_date
        FROM lead_calls c WHERE NULLIF(BTRIM(customer_notes), '') IS NOT NULL
          OR NULLIF(TO_JSONB(c)->>'buying_timeline', '') IS NOT NULL
          OR NULLIF(TO_JSONB(c)->>'budget_confirmation', '') IS NOT NULL
          OR NULLIF(TO_JSONB(c)->>'specific_requests', '') IS NOT NULL
          OR NULLIF(TO_JSONB(c)->>'customer_words', '') IS NOT NULL
          OR NULLIF(TO_JSONB(c)->>'rejection_reason', '') IS NOT NULL
          OR NULLIF(TO_JSONB(c)->>'visit_preference_date', '') IS NOT NULL
        ORDER BY call_start DESC LIMIT 5
      ) s) AS notes,
      (SELECT COUNT(*)::int FROM events) AS event_total,
      (SELECT COALESCE(JSONB_AGG(s ORDER BY s.occurred_at DESC NULLS LAST, s.type, s.id), '[]') FROM (
        SELECT * FROM events ORDER BY occurred_at DESC NULLS LAST, type, id LIMIT 100
      ) s) AS timeline
  `, [leadId, siteId]);
  return result.rows[0];
}
