const mongoose = require('mongoose');

const VehicleRoutePointSchema = new mongoose.Schema({
    // FIX B: _id String para compatibilidad con server.js original
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    vehicleId: { type: String, ref: 'Vehicle', required: true, index: true },
    lat: Number,
    lng: Number,
    speed: Number,
    ignition: Boolean,
    engineRPM: Number,
    batteryVoltage: Number,
    externalVoltage: Number,
    fuelLevel: Number,
    engineTemp: Number,
    mileage: Number,
    dtcCount: Number,
    timestamp: { type: Date, default: Date.now, expires: '7d' }
});

module.exports = mongoose.model('VehicleRoutePoint', VehicleRoutePointSchema);
