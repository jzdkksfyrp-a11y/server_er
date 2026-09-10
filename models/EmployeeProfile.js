const mongoose = require('mongoose');

// Información laboral y administrativa. Se guarda aparte de `users` para que
// los flujos de autenticación no expongan datos sensibles del expediente.
const employeeProfileSchema = new mongoose.Schema({
  // La colección users del CRM histórico usa _id String. Conservarlo como
  // texto también permite convivir con cuentas cuyo _id sea ObjectId.
  usuarioId: { type: String, required: true, unique: true, index: true },
  puesto: { type: String, trim: true, default: '' },
  departamento: { type: String, trim: true, default: '' },
  sucursal: { type: String, trim: true, default: '' },
  tipoContrato: { type: String, trim: true, default: '' },
  estadoLaboral: { type: String, trim: true, default: 'Activo' },
  fechaIngreso: Date,
  fechaNacimiento: Date,
  curp: { type: String, trim: true, default: '' },
  rfc: { type: String, trim: true, default: '' },
  nss: { type: String, trim: true, default: '' },
  direccion: { type: String, trim: true, default: '' },
  contactoEmergencia: {
    nombre: { type: String, trim: true, default: '' },
    parentesco: { type: String, trim: true, default: '' },
    telefono: { type: String, trim: true, default: '' },
  },
  banco: {
    nombre: { type: String, trim: true, default: '' },
    clabe: { type: String, trim: true, default: '' },
  },
  acceso: {
    tarjetaNumero: { type: String, trim: true, default: '' },
    employeeNo: { type: String, trim: true, default: '' },
    estado: { type: String, trim: true, default: 'Sin configurar' },
    ultimaSincronizacion: Date,
    ultimoResultado: { type: String, trim: true, default: '' },
  },
  notas: { type: String, trim: true, default: '' },
}, { collection: 'employee_profiles', timestamps: true });

module.exports = mongoose.models.EmployeeProfile || mongoose.model('EmployeeProfile', employeeProfileSchema);
