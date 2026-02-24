import pool from '../config/db.js';
import ColonyMap from '../models/ColonyMap.model.js';
import MapPlot from '../models/MapPlot.model.js';

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
        const { name, image_url, image_width, image_height, is_active } = req.body;
        const data = {};
        if (name !== undefined) data.name = name;
        if (image_url !== undefined) data.image_url = image_url;
        if (image_width !== undefined) data.image_width = image_width;
        if (image_height !== undefined) data.image_height = image_height;
        if (is_active !== undefined) data.is_active = is_active;

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
    try {
        // Explicitly delete mapped plots just in case CASCADE is missing on DB
        await pool.query('DELETE FROM map_plots WHERE colony_map_id = $1', [req.params.id]);

        const map = await ColonyMap.delete(req.params.id, pool);
        if (!map) return res.status(404).json({ success: false, message: 'Colony map not found' });
        res.json({ success: true, message: 'Colony map and associated plots deleted' });
    } catch (err) {
        console.error('deleteColonyMap error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete colony map' });
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

        // Hide sensitive lead/owner contact info for public view just in case,
        // but keep name and status
        const safePlot = { ...plot };
        delete safePlot.owner_phone;
        delete safePlot.owner_email;
        delete safePlot.lead_phone;
        delete safePlot.lead_email;
        delete safePlot.documents;
        delete safePlot.notes;

        res.json({ success: true, plot: safePlot });
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
