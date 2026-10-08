const mongoose = require('mongoose');

const bobinaSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    categoria: { type: String, enum: ['utp_cat5e', 'utp_cat6', 'utp_cat6a', 'fibra_monomodo', 'fibra_multimodo', 'control_acceso', 'audio', 'otro'], default: 'otro' },
    folio: { type: String, unique: true, sparse: true },
    metrosIniciales: { type: Number, required: true },
    metrosRestantes: { type: Number, required: true },
    estado: {
      type: String,
      enum: ['disponible', 'asignada', 'agotada', 'desecho', 'devuelta'], // devuelta = bobina externa regresada al cliente
      default: 'disponible',
    },
    // 'externa' = bobina del cliente registrada en sitio; no cuenta como existencia de la empresa
    origen: { type: String, enum: ['inventario', 'externa'], default: 'inventario' },
    // Metros disponibles cuando la bobina entró a la tarea; base del cálculo del optimizador
    metrosAlAsignar: { type: Number },
    tareaActual: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    empleadoAsignado: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Bobina', bobinaSchema);
