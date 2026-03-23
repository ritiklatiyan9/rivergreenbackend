import asyncHandler from '../utils/asyncHandler.js';
import { getPlaceName, getRoadRoute } from '../services/directions.service.js';

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isValidLatitude = (value) => value >= -90 && value <= 90;
const isValidLongitude = (value) => value >= -180 && value <= 180;

export const getDirectionsRoute = asyncHandler(async (req, res) => {
  const fromLat = toNumber(req.query.fromLat);
  const fromLng = toNumber(req.query.fromLng);
  const toLat = toNumber(req.query.toLat);
  const toLng = toNumber(req.query.toLng);

  if (
    fromLat == null || fromLng == null || toLat == null || toLng == null
    || !isValidLatitude(fromLat) || !isValidLongitude(fromLng)
    || !isValidLatitude(toLat) || !isValidLongitude(toLng)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid coordinates. Expected fromLat, fromLng, toLat, toLng.',
    });
  }

  const route = await getRoadRoute(fromLat, fromLng, toLat, toLng);
  const [fromName, toName] = await Promise.all([
    getPlaceName(fromLat, fromLng),
    getPlaceName(toLat, toLng),
  ]);

  res.json({
    success: true,
    data: {
      from: {
        latitude: fromLat,
        longitude: fromLng,
        place_name: fromName,
      },
      to: {
        latitude: toLat,
        longitude: toLng,
        place_name: toName,
      },
      route,
    },
  });
});
