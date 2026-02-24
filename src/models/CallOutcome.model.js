import MasterModel from './MasterModel.js';

class CallOutcomeModel extends MasterModel {
    constructor() {
        super('call_outcomes');
    }

    async findBySite(siteId, pool) {
        const query = `
      SELECT * FROM ${this.tableName}
      WHERE site_id = $1 AND is_active = TRUE
      ORDER BY sort_order ASC, label ASC
    `;
        const result = await pool.query(query, [siteId]);
        return result.rows;
    }

    async seedDefaults(siteId, pool) {
        const defaults = [
            { label: 'Interested', requires_followup: true, sort_order: 1 },
            { label: 'Follow-up Required', requires_followup: true, sort_order: 2 },
            { label: 'Not Reachable', requires_followup: true, sort_order: 3 },
            { label: 'Switched Off', requires_followup: true, sort_order: 4 },
            { label: 'Invalid Number', requires_followup: false, sort_order: 5 },
            { label: 'Call Back Later', requires_followup: true, sort_order: 6 },
            { label: 'Budget Issue', requires_followup: false, sort_order: 7 },
            { label: 'Site Visit Requested', requires_followup: true, sort_order: 8 },
            { label: 'Negotiation Ongoing', requires_followup: true, sort_order: 9 },
            { label: 'Not Interested', requires_followup: false, sort_order: 10 },
        ];

        const existing = await this.findBySite(siteId, pool);
        if (existing.length > 0) return existing;

        const results = [];
        for (const item of defaults) {
            const row = await this.create({ ...item, site_id: siteId }, pool);
            results.push(row);
        }
        return results;
    }
}

export default new CallOutcomeModel();
