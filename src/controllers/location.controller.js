import pool from '../config/db.js';
import agentLiveLocationModel from '../models/AgentLiveLocation.model.js';

export const getLiveLocations = async (req, res) => {
  try {
    const locations = await agentLiveLocationModel.getAllActiveLocations(pool);
    res.json({
      success: true,
      locations
    });
  } catch (err) {
    console.error('Error fetching live locations:', err);
    res.status(500).json({ success: false, message: 'Server error fetching live locations.' });
  }
};
