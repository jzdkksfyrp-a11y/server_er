const mongoose = require('mongoose');

// El contenido se excluye siempre de las listas; se entrega únicamente al
// solicitar un archivo concreto desde la ruta protegida de expedientes.
const employeeDocumentSchema = new mongoose.Schema({
  usuarioId: { type: String, required: true, index: true },
  nombre: { type: String, required: true, trim: true },
  tipo: { type: String, trim: true, default: 'Documento' },
  contentType: { type: String, default: 'application/octet-stream' },
  tamanio: { type: Number, default: 0 },
  datos: { type: String, required: true, select: false },
}, { collection: 'employee_documents', timestamps: true });

module.exports = mongoose.models.EmployeeDocument || mongoose.model('EmployeeDocument', employeeDocumentSchema);
