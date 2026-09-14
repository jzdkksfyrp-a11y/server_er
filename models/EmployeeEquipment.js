const mongoose = require('mongoose');

// Equipo bajo resguardo de una persona. Se conserva el registro cuando se
// devuelve o se da de baja para que el expediente mantenga su historial.
const employeeEquipmentSchema = new mongoose.Schema({
  usuarioId: { type: String, required: true, index: true },
  tipo: { type: String, enum: ['Herramienta', 'Equipo personal'], required: true },
  nombre: { type: String, trim: true, required: true },
  numeroSerie: { type: String, trim: true, default: '' },
  notas: { type: String, trim: true, default: '' },
  estado: { type: String, enum: ['Asignado', 'Devuelto', 'Faltante', 'Baja'], default: 'Asignado' },
  fechaAsignacion: { type: Date, default: Date.now },
  fechaDevolucion: { type: Date, default: null },
}, { collection: 'employee_equipment', timestamps: true });

module.exports = mongoose.models.EmployeeEquipment || mongoose.model('EmployeeEquipment', employeeEquipmentSchema);
