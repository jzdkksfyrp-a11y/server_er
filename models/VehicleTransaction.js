const mongoose = require('mongoose');

const VehicleTransactionSchema = new mongoose.Schema({
    vehicleId: { type: String, ref: 'Vehicle', required: true },
    userId: { type: String, required: false },
    userName: { type: String, required: false },
    tipoMovimiento: { type: String, enum: ['Salida', 'Devolucion', 'Devolución', 'Préstamo', 'Gasolina', 'Mantenimiento', 'Asignación'], required: true },
    responsable: { type: String, required: false },
    proyectoId: { type: String, required: false }, // Asociar a un proyecto
    motivo: { type: String, required: false },
    kilometraje: { type: Number, required: false },
    firma: { type: String, required: false }, // Base64
    firmaUsuario: { type: String, required: false }, // Base64
    notas: { type: String, required: false },
    bitacoraRevisada: { type: [String], default: [] },
    imgReporteDanos: { type: String, required: false },
    estadoConfirmacion: { type: String, enum: ['Confirmado', 'Pendiente', 'Rechazado'], default: 'Confirmado' },
    checklist: {
        aceite: { type: Boolean, default: true },
        llantas: { type: Boolean, default: true },
        limpieza: { type: Boolean, default: true },
        documentos: { type: Boolean, default: true }
    },
    checklistNotas: { type: String, default: '' },
    gasolinaMonto: { type: Number, default: 0 },
    gasolinaLitros: { type: Number, default: 0 },
    gasolinaFoto: { type: String, default: '' },
    mantenimientoCosto: { type: Number, default: 0 },
    mantenimientoPiezas: { type: String, default: '' },
    mantenimientoTaller: { type: String, default: '' },
    inspeccionPreviaje: { type: Object, default: {} },
    fecha: { type: Date, default: Date.now },
    fechaAceptacion: { type: Date, required: false },
    fechaSolicitudDevolucion: { type: Date, required: false },
    fechaDevolucion: { type: Date, required: false }
}, { timestamps: true });

VehicleTransactionSchema.index({ vehicleId: 1, fecha: -1 });

module.exports = mongoose.model('VehicleTransaction', VehicleTransactionSchema);
