const mongoose = require('mongoose');

const bobinaSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    categoria: { type: String, enum: ['utp_cat5e', 'utp_cat6', 'utp_cat6a', 'fibra_monomodo', 'fibra_multimodo', 'control_acceso', 'otro'], default: 'otro' },
    folio: { type: String, unique: true, sparse: true },
    metrosIniciales: { type: Number, required: true },
    metrosRestantes: { type: Number, required: true },
    estado: {
      type: String,
      enum: ['disponible', 'asignada', 'agotada', 'desecho'],
      default: 'disponible',
    },
    tareaActual: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    empleadoAsignado: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Bobina', bobinaSchema);
