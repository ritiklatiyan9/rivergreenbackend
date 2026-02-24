import MasterModel from './MasterModel.js';

class CallModel extends MasterModel {
  constructor() {
    super('calls');
  }

  // List calls with joined data — paginated, filterable, role-scoped
  async findWithDetails({ siteId, assignedTo, teamId, leadId, outcomeId, dateFrom, dateTo, page = 1, limit = 20 }, pool) {
    const conditions = ['c.site_id = $1'];
    const params = [siteId];
    let idx = 2;

    if (assignedTo) {
      conditions.push(`c.assigned_to = $${idx++}`);
      params.push(assignedTo);
    }
    if (teamId) {
      conditions.push(`u_agent.team_id = $${idx++}`);
      params.push(teamId);
    }
    if (leadId) {
      conditions.push(`c.lead_id = $${idx++}`);
      params.push(leadId);
    }
    if (outcomeId) {
      conditions.push(`c.outcome_id = $${idx++}`);
      params.push(outcomeId);
    }
    if (dateFrom) {
      conditions.push(`c.call_start >= $${idx++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`c.call_start <= $${idx++}`);
      params.push(dateTo);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM ${this.tableName} c
      JOIN users u_agent ON c.assigned_to = u_agent.id
      WHERE ${where}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const query = `
      SELECT c.*,
        l.name as lead_name, l.phone as lead_phone, l.status as lead_status,
        u_agent.name as agent_name, u_agent.email as agent_email,
        co.label as outcome_label, co.requires_followup
      FROM ${this.tableName} c
      LEFT JOIN leads l ON c.lead_id = l.id
      LEFT JOIN users u_agent ON c.assigned_to = u_agent.id
      LEFT JOIN call_outcomes co ON c.outcome_id = co.id
      WHERE ${where}
      ORDER BY c.call_start DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(limit, offset);
    const result = await pool.query(query, params);

    return {
      calls: result.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Get calls for a specific lead (timeline view)
  async findByLead(leadId, pool) {
    const query = `
      SELECT c.*,
        u_agent.name as agent_name,
        co.label as outcome_label
      FROM ${this.tableName} c
      LEFT JOIN users u_agent ON c.assigned_to = u_agent.id
      LEFT JOIN call_outcomes co ON c.outcome_id = co.id
      WHERE c.lead_id = $1
      ORDER BY c.call_start DESC
    `;
    const result = await pool.query(query, [leadId]);
    return result.rows;
  }

  // Single call with full details
  async findByIdWithDetails(id, pool) {
    const query = `
      SELECT c.*,
        l.name as lead_name, l.phone as lead_phone, l.email as lead_email, l.status as lead_status,
        u_agent.name as agent_name, u_agent.email as agent_email,
        u_creator.name as creator_name,
        co.label as outcome_label, co.requires_followup
      FROM ${this.tableName} c
      LEFT JOIN leads l ON c.lead_id = l.id
      LEFT JOIN users u_agent ON c.assigned_to = u_agent.id
      LEFT JOIN users u_creator ON c.created_by = u_creator.id
      LEFT JOIN call_outcomes co ON c.outcome_id = co.id
      WHERE c.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  // Analytics — aggregated metrics
  async getAnalytics({ siteId, assignedTo, teamId, dateFrom, dateTo }, pool) {
    const conditions = ['c.site_id = $1'];
    const params = [siteId];
    let idx = 2;

    if (assignedTo) {
      conditions.push(`c.assigned_to = $${idx++}`);
      params.push(assignedTo);
    }
    if (teamId) {
      conditions.push(`u.team_id = $${idx++}`);
      params.push(teamId);
    }
    if (dateFrom) {
      conditions.push(`c.call_start >= $${idx++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`c.call_start <= $${idx++}`);
      params.push(dateTo);
    }

    const where = conditions.join(' AND ');

    // Main metrics
    const metricsQuery = `
      SELECT
        COUNT(*) as total_calls,
        COUNT(*) FILTER (WHERE c.call_start >= CURRENT_DATE) as today_calls,
        COUNT(*) FILTER (WHERE c.call_start >= CURRENT_DATE - INTERVAL '7 days') as week_calls,
        COUNT(*) FILTER (WHERE c.call_start >= DATE_TRUNC('month', CURRENT_DATE)) as month_calls,
        COALESCE(ROUND(AVG(c.duration_seconds)), 0) as avg_duration,
        COUNT(*) FILTER (WHERE c.next_action = 'VISIT') as visit_requests,
        COUNT(*) FILTER (WHERE c.next_action = 'CLOSE') as closed_calls
      FROM ${this.tableName} c
      LEFT JOIN users u ON c.assigned_to = u.id
      WHERE ${where}
    `;
    const metricsResult = await pool.query(metricsQuery, params);

    // Outcome distribution
    const outcomeQuery = `
      SELECT co.label, COUNT(*) as count
      FROM ${this.tableName} c
      LEFT JOIN users u ON c.assigned_to = u.id
      LEFT JOIN call_outcomes co ON c.outcome_id = co.id
      WHERE ${where} AND co.label IS NOT NULL
      GROUP BY co.label
      ORDER BY count DESC
    `;
    const outcomeResult = await pool.query(outcomeQuery, params);

    // Calls per agent + Assigned leads
    const agentQuery = `
      SELECT
        u.name as agent_name,
        u.id as agent_id,
        u.role as agent_role,
        COUNT(DISTINCT c.id) as call_count,
        COALESCE(ROUND(AVG(c.duration_seconds)), 0) as avg_duration,
        (SELECT COUNT(DISTINCT l.id) FROM leads l WHERE l.assigned_to = u.id AND l.site_id = $1) as assigned_leads
      FROM users u
      LEFT JOIN ${this.tableName} c ON c.assigned_to = u.id AND ${where.replace(/u\./g, 'u_inner.')}
      WHERE u.site_id = $1 AND u.role IN ('AGENT', 'TEAM_HEAD')
      GROUP BY u.id, u.name, u.role
      ORDER BY call_count DESC
      LIMIT 20
    `;
    // Note: The where clause above for c needs careful handling if it filters by agent_id or team_id
    // But since this is a summary of all agents, we use a simpler approach for the inner join if possible
    // or adjust the where clause.

    // Revised Agent Query to be more robust with filters
    const agentPerformanceQuery = `
      WITH agent_stats AS (
        SELECT 
            u.id as agent_id, 
            u.name as agent_name, 
            u.role as agent_role,
            (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.site_id = $1) as assigned_leads
        FROM users u
        WHERE u.site_id = $1 AND u.role IN ('AGENT', 'TEAM_HEAD', 'ADMIN')
      )
      SELECT 
        ast.agent_id, 
        ast.agent_name, 
        ast.agent_role,
        ast.assigned_leads,
        COUNT(c.id) as call_count,
        COALESCE(ROUND(AVG(c.duration_seconds)), 0) as avg_duration
      FROM agent_stats ast
      LEFT JOIN ${this.tableName} c ON c.assigned_to = ast.agent_id AND ${where.replace(/c\.site_id = \$1/g, 'TRUE')}
      GROUP BY ast.agent_id, ast.agent_name, ast.agent_role, ast.assigned_leads
      ORDER BY call_count DESC
    `;
    const agentResult = await pool.query(agentPerformanceQuery, params);

    // Daily call trend (last 30 days)
    const trendQuery = `
      SELECT DATE(c.call_start) as date, COUNT(*) as count
      FROM ${this.tableName} c
      LEFT JOIN users u ON c.assigned_to = u.id
      WHERE ${where} AND c.call_start >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(c.call_start)
      ORDER BY date ASC
    `;
    const trendResult = await pool.query(trendQuery, params);

    // Bookings from leads that have calls (conversion)
    const conversionQuery = `
      SELECT
        COUNT(DISTINCT c.lead_id) as leads_with_calls,
        COUNT(DISTINCT b.lead_id) as leads_with_bookings
      FROM ${this.tableName} c
      LEFT JOIN users u ON c.assigned_to = u.id
      LEFT JOIN bookings b ON c.lead_id = b.lead_id
      WHERE ${where}
    `;
    const conversionResult = await pool.query(conversionQuery, params);

    return {
      metrics: metricsResult.rows[0],
      outcomeDistribution: outcomeResult.rows,
      agentPerformance: agentResult.rows,
      dailyTrend: trendResult.rows,
      conversion: conversionResult.rows[0],
    };
  }

  // Bulk create calls (for Daily Entry page)
  async bulkCreate(callsArray, pool) {
    if (!callsArray || callsArray.length === 0) return [];

    const columns = [
      'site_id', 'lead_id', 'assigned_to', 'created_by',
      'call_type', 'call_start', 'call_end', 'duration_seconds',
      'outcome_id', 'next_action', 'customer_notes', 'customer_words',
      'agent_action', 'is_manual_log',
    ];

    const values = [];
    const placeholders = [];
    let idx = 1;

    for (const call of callsArray) {
      const row = [];
      for (const col of columns) {
        values.push(call[col] !== undefined ? call[col] : null);
        row.push(`$${idx++}`);
      }
      placeholders.push(`(${row.join(', ')})`);
    }

    const query = `
      INSERT INTO ${this.tableName} (${columns.join(', ')})
      VALUES ${placeholders.join(', ')}
      RETURNING *
    `;
    const result = await pool.query(query, values);
    return result.rows;
  }

  // Follow-up compliance metric
  async getFollowupCompliance(siteId, assignedTo, pool) {
    const userFilter = assignedTo ? `AND c.assigned_to = $2` : '';
    const params = assignedTo ? [siteId, assignedTo] : [siteId];

    const query = `
      SELECT
        COUNT(*) FILTER (WHERE co.requires_followup = TRUE) as calls_needing_followup,
        COUNT(DISTINCT f.id) FILTER (WHERE co.requires_followup = TRUE AND f.id IS NOT NULL) as followups_created
      FROM ${this.tableName} c
      LEFT JOIN call_outcomes co ON c.outcome_id = co.id
      LEFT JOIN followups f ON f.call_id = c.id
      WHERE c.site_id = $1 ${userFilter}
        AND c.call_start >= CURRENT_DATE - INTERVAL '30 days'
    `;
    const result = await pool.query(query, params);
    const row = result.rows[0];
    const needed = parseInt(row.calls_needing_followup) || 0;
    const created = parseInt(row.followups_created) || 0;
    return {
      needed,
      created,
      compliancePercent: needed > 0 ? Math.round((created / needed) * 100) : 100,
    };
  }
}

export default new CallModel();
