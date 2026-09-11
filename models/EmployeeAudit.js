const mongoose = require('mongoose');

const employeeAuditSchema = new mongoose.Schema({
  empleadoId: { type: String, required: true, index: true },
  actorId: { type: String, required: true },
  accion: { type: String, required: true },
  detalle: { type: String, default: '' },
  metadatos: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { collection: 'employee_audit', timestamps: true });

module.exports = mongoose.models.EmployeeAudit || mongoose.model('EmployeeAudit', employeeAuditSchema);
