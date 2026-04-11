import MasterModel from './MasterModel.js';

class TaskModel extends MasterModel {
    constructor() {
        super('admin_tasks');
    }

    async findBySite(siteId, filters, pool) {
        let whereClauses = ['t.site_id = $1'];
        let params = [siteId];
        let paramIndex = 2;

        if (filters.status) {
            whereClauses.push(`t.status = $${paramIndex++}`);
            params.push(filters.status);
        }

        if (filters.priority) {
            whereClauses.push(`t.priority = $${paramIndex++}`);
            params.push(filters.priority);
        }

        if (filters.due_date) {
            whereClauses.push(`t.current_due_date = $${paramIndex++}`);
            params.push(filters.due_date);
        }

        if (filters.search) {
            whereClauses.push(`(t.title ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex})`);
            params.push(`%${filters.search}%`);
            paramIndex++;
        }

        if (filters.overdue) {
            whereClauses.push(`t.current_due_date < CURRENT_DATE AND t.status NOT IN ('DONE', 'CANCELLED')`);
        }

        const whereString = whereClauses.join(' AND ');

        const query = `
            SELECT t.*, u.name as created_by_name,
                   CASE WHEN t.current_due_date < CURRENT_DATE AND t.status NOT IN ('DONE', 'CANCELLED')
                        THEN true ELSE false END as is_overdue,
                   CASE WHEN t.original_due_date != t.current_due_date
                        THEN true ELSE false END as was_shifted
            FROM ${this.tableName} t
            LEFT JOIN users u ON t.created_by = u.id
            WHERE ${whereString}
            ORDER BY
                CASE t.status
                    WHEN 'IN_PROGRESS' THEN 0
                    WHEN 'TODO' THEN 1
                    WHEN 'DONE' THEN 2
                    WHEN 'CANCELLED' THEN 3
                END,
                CASE t.priority
                    WHEN 'URGENT' THEN 0
                    WHEN 'HIGH' THEN 1
                    WHEN 'MEDIUM' THEN 2
                    WHEN 'LOW' THEN 3
                END,
                t.current_due_date ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    async getStats(siteId, pool) {
        const query = `
            SELECT
                COUNT(*) FILTER (WHERE status = 'TODO')::int as todo_count,
                COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int as in_progress_count,
                COUNT(*) FILTER (WHERE status = 'DONE')::int as done_count,
                COUNT(*) FILTER (WHERE status = 'CANCELLED')::int as cancelled_count,
                COUNT(*) FILTER (WHERE current_due_date < CURRENT_DATE AND status NOT IN ('DONE', 'CANCELLED'))::int as overdue_count,
                COUNT(*) FILTER (WHERE current_due_date = CURRENT_DATE AND status NOT IN ('DONE', 'CANCELLED'))::int as due_today_count,
                COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at >= NOW() - INTERVAL '7 days')::int as completed_this_week,
                COUNT(*)::int as total_count
            FROM ${this.tableName}
            WHERE site_id = $1
        `;
        const result = await pool.query(query, [siteId]);
        return result.rows[0];
    }

    async getShiftHistory(taskId, pool) {
        const query = `
            SELECT * FROM admin_task_shifts
            WHERE task_id = $1
            ORDER BY shifted_at DESC
        `;
        const result = await pool.query(query, [taskId]);
        return result.rows;
    }

    async shiftDueDate(taskId, newDate, reason, pool) {
        // Get current due date
        const task = await this.findById(taskId, pool);
        if (!task) return null;

        // Log the shift
        await pool.query(
            `INSERT INTO admin_task_shifts (task_id, previous_date, new_date, reason)
             VALUES ($1, $2, $3, $4)`,
            [taskId, task.current_due_date, newDate, reason || 'Rescheduled']
        );

        // Update task
        const result = await pool.query(
            `UPDATE ${this.tableName} SET current_due_date = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [newDate, taskId]
        );
        return result.rows[0];
    }

    async autoShiftOverdue(siteId, pool) {
        // Find overdue tasks and shift them to today
        const overdueTasks = await pool.query(
            `SELECT id, current_due_date FROM ${this.tableName}
             WHERE site_id = $1 AND current_due_date < CURRENT_DATE
             AND status NOT IN ('DONE', 'CANCELLED')`,
            [siteId]
        );

        const shifted = [];
        for (const task of overdueTasks.rows) {
            // Log each shift
            await pool.query(
                `INSERT INTO admin_task_shifts (task_id, previous_date, new_date, reason)
                 VALUES ($1, $2, CURRENT_DATE, 'Auto-shifted: overdue')`,
                [task.id, task.current_due_date]
            );

            await pool.query(
                `UPDATE ${this.tableName} SET current_due_date = CURRENT_DATE, updated_at = NOW()
                 WHERE id = $1`,
                [task.id]
            );
            shifted.push(task.id);
        }

        return shifted;
    }
}

export default new TaskModel();
