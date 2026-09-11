const mongoose = require('mongoose');

const VehicleSchema = new mongoose.Schema({
    // FIX B: _id como String para compatibilidad con datos del servidor original
    // El server.js original usa _id String, sin esto los findById() fallan en documentos existentes
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    marca: { type: String, required: true },
    modelo: { type: String, required: true },
    color: { type: String, required: true },
    placas: { type: String, required: true, unique: true },
    estado: { type: String, enum: ['Disponible', 'Prestado', 'Mantenimiento', 'Pendiente de Confirmación'], default: 'Disponible' },
    bitacoraEsperada: { type: [String], default: ['Gato', 'Refacción', 'Cables auxiliares', 'Extintor'] },
    equipmentPhotos: { type: [String], default: [] },
    documentosVehiculo: { type: [String], default: [] },
    lastDamageReport: { type: String, default: '' },
    currentUserId: { type: String, default: null },
    currentUserName: { type: String, default: null },
    encendido: { type: Boolean, default: false },
    kilometrajeActual: { type: Number, default: 0 },
    proximoServicioKm: { type: Number, default: 10000 },
    vencimientoSeguro: { type: Date, default: null },
    vencimientoVerificacion: { type: Date, default: null },
    imei: { type: String, default: '' },
    flespiId: { type: String, default: '' },
    gpsModel: { type: String, default: 'FMC920' },
    ghostMode: { type: Boolean, default: false },
    lastLocation: { type: Object, default: null },
    locationHistory: { type: [Object], default: [] },
    currentStopId: { type: String, default: null },
    destinoSugeridoCRM: { type: String, default: '' },
    crmActividadId: { type: String, default: null },
    crmProyectoId: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Vehicle', VehicleSchema);
