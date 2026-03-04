import pool from '../config/db.js';
import ColonyMap from '../models/ColonyMap.model.js';
import MapPlot from '../models/MapPlot.model.js';

// ─── Upload Map Image ───────────────────────────────────────

export const uploadMapImage = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image file uploaded' });
        }
        const imageUrl = `/uploads/${req.file.filename}`;
        const map = await ColonyMap.update(req.params.id, { image_url: imageUrl }, pool);
        if (!map) return res.status(404).json({ success: false, message: 'Colony map not found' });
        res.json({ success: true, map, image_url: imageUrl });
    } catch (err) {
        console.error('uploadMapImage error:', err);
        res.status(500).json({ success: false, message: 'Failed to upload map image' });
    }
};

// ─── Colony Map CRUD ────────────────────────────────────────

export const getColonyMaps = async (req, res) => {
    try {
        const maps = await ColonyMap.findBySite(req.user.site_id, pool);
        res.json({ success: true, maps });
    } catch (err) {
        console.error('getColonyMaps error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch colony maps' });
    }
};

export const getColonyMap = async (req, res) => {
    try {
        const map = await ColonyMap.findByIdWithPlots(req.params.id, req.user.site_id, pool);
        if (!map) return res.status(404).json({ success: false, message: 'Colony map not found' });
        res.json({ success: true, map });
    } catch (err) {
        console.error('getColonyMap error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch colony map' });
    }
};

export const createColonyMap = async (req, res) => {
    try {
        const { name, image_url, image_width, image_height } = req.body;
        if (!name || !image_url) {
            return res.status(400).json({ success: false, message: 'Name and image are required' });
        }
        const map = await ColonyMap.create({
            site_id: req.user.site_id,
            name,
            image_url,
            image_width: image_width || 0,
            image_height: image_height || 0,
            created_by: req.user.id,
        }, pool);
        res.status(201).json({ success: true, map });
    } catch (err) {
        console.error('createColonyMap error:', err);
        res.status(500).json({ success: false, message: 'Failed to create colony map' });
    }
};

export const updateColonyMap = async (req, res) => {
    try {
        const { name, image_url, image_width, image_height, is_active, layout_config } = req.body;
        const data = {};
        if (name !== undefined) data.name = name;
        if (image_url !== undefined) data.image_url = image_url;
        if (image_width !== undefined) data.image_width = image_width;
        if (image_height !== undefined) data.image_height = image_height;
        if (is_active !== undefined) data.is_active = is_active;
        if (layout_config !== undefined) data.layout_config = JSON.stringify(layout_config);

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        const map = await ColonyMap.update(req.params.id, data, pool);
        if (!map) return res.status(404).json({ success: false, message: 'Colony map not found' });
        res.json({ success: true, map });
    } catch (err) {
        console.error('updateColonyMap error:', err);
        res.status(500).json({ success: false, message: 'Failed to update colony map' });
    }
};

export const deleteColonyMap = async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const mapId = req.params.id;

        // 1. Get all plot IDs belonging to this map
        const plotRes = await client.query('SELECT id FROM map_plots WHERE colony_map_id = $1', [mapId]);
        const plotIds = plotRes.rows.map(r => r.id);

        if (plotIds.length > 0) {
            // 2. Delete payments referencing these plots
            await client.query('DELETE FROM payments WHERE plot_id = ANY($1::uuid[])', [plotIds]);
            // 3. Delete client_activities referencing these plots
            await client.query('DELETE FROM client_activities WHERE plot_id = ANY($1::uuid[])', [plotIds]);
            // 4. Delete plot_bookings referencing these plots or this colony map
            await client.query('DELETE FROM plot_bookings WHERE plot_id = ANY($1::uuid[]) OR colony_map_id = $2', [plotIds, mapId]);
            // 5. Delete the plots themselves
            await client.query('DELETE FROM map_plots WHERE colony_map_id = $1', [mapId]);
        } else {
            // Still clean up any orphaned bookings referencing this map
            await client.query('DELETE FROM plot_bookings WHERE colony_map_id = $1', [mapId]);
        }

        // 6. Delete the colony map
        const result = await client.query('DELETE FROM colony_maps WHERE id = $1 RETURNING *', [mapId]);
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Colony map not found' });
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Colony map and all associated data deleted' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('deleteColonyMap error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete colony map: ' + err.message });
    } finally {
        client.release();
    }
};

// ─── Plot CRUD ──────────────────────────────────────────────

export const createPlot = async (req, res) => {
    try {
        const { id: colonyMapId } = req.params;
        const {
            plot_number, block, plot_type, polygon_points, fill_color,
            area_sqft, area_sqm, dimensions, facing, price_per_sqft, total_price,
            status, owner_name, owner_phone, owner_email, owner_address,
            booking_date, booking_amount, payment_plan, registry_date, registry_number,
            lead_id, assigned_agent, referred_by, notes, documents,
        } = req.body;

        if (!plot_number || !polygon_points || !Array.isArray(polygon_points)) {
            return res.status(400).json({ success: false, message: 'plot_number and polygon_points are required' });
        }

        const num = v => (v === '' || v === undefined || v === null) ? null : Number(v);
        const str = v => (v === '' || v === undefined || v === null) ? null : v;

        const plot = await MapPlot.create({
            colony_map_id: colonyMapId,
            site_id: req.user.site_id,
            plot_number,
            block: str(block),
            plot_type: plot_type || 'RESIDENTIAL',
            polygon_points: JSON.stringify(polygon_points),
            fill_color: fill_color || '#4A90D9',
            area_sqft: num(area_sqft),
            area_sqm: num(area_sqm),
            dimensions: str(dimensions),
            facing: str(facing),
            price_per_sqft: num(price_per_sqft),
            total_price: num(total_price),
            status: status || 'AVAILABLE',
            owner_name: str(owner_name),
            owner_phone: str(owner_phone),
            owner_email: str(owner_email),
            owner_address: str(owner_address),
            booking_date: str(booking_date),
            booking_amount: num(booking_amount),
            payment_plan: str(payment_plan),
            registry_date: str(registry_date),
            registry_number: str(registry_number),
            lead_id: lead_id || null,
            assigned_agent: assigned_agent || null,
            referred_by: referred_by || null,
            notes: str(notes),
            documents: documents ? JSON.stringify(documents) : '[]',
            created_by: req.user.id,
            updated_by: req.user.id,
        }, pool);

        res.status(201).json({ success: true, plot });
    } catch (err) {
        console.error('createPlot error:', err);
        res.status(500).json({ success: false, message: 'Failed to create plot' });
    }
};

export const updatePlot = async (req, res) => {
    try {
        const { plotId } = req.params;
        const allowed = [
            'plot_number', 'block', 'plot_type', 'polygon_points', 'fill_color',
            'area_sqft', 'area_sqm', 'dimensions', 'facing', 'price_per_sqft', 'total_price',
            'status', 'owner_name', 'owner_phone', 'owner_email', 'owner_address',
            'booking_date', 'booking_amount', 'payment_plan', 'registry_date', 'registry_number',
            'lead_id', 'assigned_agent', 'referred_by', 'notes', 'documents',
        ];

        const data = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                if (key === 'polygon_points' || key === 'documents') {
                    data[key] = JSON.stringify(req.body[key]);
                } else {
                    data[key] = req.body[key];
                }
            }
        }
        data.updated_by = req.user.id;

        if (Object.keys(data).length <= 1) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        const plot = await MapPlot.update(plotId, data, pool);
        if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });
        res.json({ success: true, plot });
    } catch (err) {
        console.error('updatePlot error:', err);
        res.status(500).json({ success: false, message: 'Failed to update plot' });
    }
};

export const deletePlot = async (req, res) => {
    try {
        const plot = await MapPlot.delete(req.params.plotId, pool);
        if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });
        res.json({ success: true, message: 'Plot deleted' });
    } catch (err) {
        console.error('deletePlot error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete plot' });
    }
};

export const getPlot = async (req, res) => {
    try {
        const plot = await MapPlot.findByIdFull(req.params.plotId, pool);
        if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });
        res.json({ success: true, plot });
    } catch (err) {
        console.error('getPlot error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch plot' });
    }
};

export const getPublicPlot = async (req, res) => {
    try {
        // Find plot by ID (no auth required for this shared view)
        const plot = await MapPlot.findByIdFull(req.params.plotId, pool);
        if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });

        // Hide sensitive lead/owner contact info for public view
        const safePlot = { ...plot };
        delete safePlot.owner_phone;
        delete safePlot.owner_email;
        delete safePlot.lead_phone;
        delete safePlot.lead_email;
        delete safePlot.documents;
        delete safePlot.notes;

        // Fetch full colony data (layout_config + all plots) for interactive map
        let colonyData = null;
        if (plot.colony_map_id) {
            const mapRes = await pool.query(
                `SELECT id, name, image_url, layout_config FROM colony_maps WHERE id = $1`,
                [plot.colony_map_id]
            );
            if (mapRes.rows.length > 0) {
                const map = mapRes.rows[0];
                const plotsRes = await pool.query(
                    `SELECT id, plot_number, polygon_points, fill_color, status FROM map_plots WHERE colony_map_id = $1`,
                    [plot.colony_map_id]
                );
                colonyData = {
                    id: map.id,
                    name: map.name,
                    image_url: map.image_url || null,
                    layout_config: map.layout_config,
                    plots: plotsRes.rows,
                };
            }
        }

        // If ?ref= sponsor_code is provided, look up the agent
        let referringAgent = null;
        const refCode = req.query.ref;
        if (refCode) {
            const agentRes = await pool.query(
                `SELECT id, name, sponsor_code, phone, profile_photo FROM users WHERE UPPER(sponsor_code) = UPPER($1) AND is_active = true`,
                [refCode]
            );
            if (agentRes.rows.length > 0) {
                const a = agentRes.rows[0];
                referringAgent = { id: a.id, name: a.name, sponsor_code: a.sponsor_code, phone: a.phone, profile_photo: a.profile_photo };
            }
        }

        res.json({ success: true, plot: safePlot, referringAgent, colonyData });
    } catch (err) {
        console.error('getPublicPlot error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch plot' });
    }
};

export const updatePlotStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['AVAILABLE', 'BOOKED', 'SOLD', 'RESERVED', 'BLOCKED', 'MORTGAGE', 'REGISTRY_PENDING'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }
        const plot = await MapPlot.updateStatus(req.params.plotId, status, req.user.id, pool);
        if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });
        res.json({ success: true, plot });
    } catch (err) {
        console.error('updatePlotStatus error:', err);
        res.status(500).json({ success: false, message: 'Failed to update plot status' });
    }
};

// Bulk save plots (for the editor — save all at once)
export const bulkSavePlots = async (req, res) => {
    try {
        const { id: colonyMapId } = req.params;
        const { plots } = req.body;

        if (!Array.isArray(plots)) {
            return res.status(400).json({ success: false, message: 'plots array is required' });
        }

        const results = [];
        for (const p of plots) {
            if (p.id) {
                // Update existing
                const data = { ...p, updated_by: req.user.id };
                if (data.polygon_points) data.polygon_points = JSON.stringify(data.polygon_points);
                if (data.documents) data.documents = JSON.stringify(data.documents);
                delete data.id;
                delete data.colony_map_id;
                delete data.site_id;
                const updated = await MapPlot.update(p.id, data, pool);
                if (updated) results.push(updated);
            } else {
                // Create new
                const created = await MapPlot.create({
                    colony_map_id: colonyMapId,
                    site_id: req.user.site_id,
                    plot_number: p.plot_number || 'UNNAMED',
                    polygon_points: JSON.stringify(p.polygon_points || []),
                    fill_color: p.fill_color || '#4A90D9',
                    block: p.block,
                    plot_type: p.plot_type || 'RESIDENTIAL',
                    area_sqft: p.area_sqft,
                    dimensions: p.dimensions,
                    status: p.status || 'AVAILABLE',
                    created_by: req.user.id,
                    updated_by: req.user.id,
                }, pool);
                results.push(created);
            }
        }

        res.json({ success: true, plots: results });
    } catch (err) {
        console.error('bulkSavePlots error:', err);
        res.status(500).json({ success: false, message: 'Failed to save plots' });
    }
};

export const getMapStats = async (req, res) => {
    try {
        const summary = await MapPlot.getStatusSummary(req.params.id, pool);
        res.json({ success: true, summary });
    } catch (err) {
        console.error('getMapStats error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch map stats' });
    }
};

// ─── Create Colony with Quadrant Layout ──────────────────
// Admin specifies 4 quadrants (TL/TR/BL/BR) with rows+cols + road interval.
// Creates colony_map + generates all plot records in one atomic transaction.
export const initializeLayout = async (req, res) => {
    const client = await pool.connect();
    try {
        // Ensure layout_config column exists
        await client.query(
            `ALTER TABLE colony_maps ADD COLUMN IF NOT EXISTS layout_config JSONB DEFAULT '{}'::jsonb`
        );

        await client.query('BEGIN');

        const { name, layoutConfig } = req.body;
        if (!name || !layoutConfig) {
            return res.status(400).json({ success: false, message: 'name and layoutConfig are required' });
        }

        const { topLeft, topRight, bottomLeft, bottomRight } = layoutConfig;

        // Create the colony map record with layout_config
        const mapRes = await client.query(
            `INSERT INTO colony_maps (site_id, name, image_url, image_width, image_height, layout_config, created_by)
             VALUES ($1, $2, '', 0, 0, $3, $4) RETURNING id`,
            [req.user.site_id, name, JSON.stringify(layoutConfig), req.user.id]
        );
        const mapId = mapRes.rows[0].id;

        // Generate plot positions from 4 quadrants
        const plotPositions = [];
        const quads = [
            { key: 'TL', cfg: topLeft },
            { key: 'TR', cfg: topRight },
            { key: 'BL', cfg: bottomLeft },
            { key: 'BR', cfg: bottomRight },
        ];

        for (const { key, cfg } of quads) {
            if (!cfg?.rows || !cfg?.cols) continue;
            for (let r = 0; r < cfg.rows; r++) {
                for (let c = 0; c < cfg.cols; c++) {
                    plotPositions.push({ gridKey: `${key}-${r}-${c}`, quadrant: key, row: r, col: c });
                }
            }
        }

        if (plotPositions.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No plots to create — check quadrant configuration' });
        }

        // Batch insert all plots in chunks of 50
        const CHUNK = 50;
        for (let i = 0; i < plotPositions.length; i += CHUNK) {
            const chunk = plotPositions.slice(i, i + CHUNK);
            const values = [];
            const placeholders = [];
            let idx = 1;

            for (const p of chunk) {
                placeholders.push(
                    `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
                );
                values.push(
                    mapId,
                    req.user.site_id,
                    p.gridKey,
                    JSON.stringify([{ quadrant: p.quadrant, row: p.row, col: p.col }]),
                    '#22c55e',
                    'AVAILABLE',
                    req.user.id,
                    req.user.id
                );
            }

            await client.query(
                `INSERT INTO map_plots
                     (colony_map_id, site_id, plot_number, polygon_points, fill_color, status, created_by, updated_by)
                 VALUES ${placeholders.join(', ')}`,
                values
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, mapId, plotCount: plotPositions.length });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('initializeLayout error:', err);
        res.status(500).json({ success: false, message: 'Failed to create colony: ' + err.message });
    } finally {
        client.release();
    }
};
