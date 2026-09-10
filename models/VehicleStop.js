const mongoose = require('mongoose');

const VehicleStopSchema = new mongoose.Schema({
    vehicleId: { type: String, ref: 'Vehicle', required: true, index: true },
    userId: { type: String, default: null },
    userName: { type: String, default: null },
    lat: Number,
    lng: Number,
    startTime: { type: Date, required: true },
    endTime: { type: Date, default: null },
    durationMinutes: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: '7d' }
});

module.exports = mongoose.model('VehicleStop', VehicleStopSchema);
