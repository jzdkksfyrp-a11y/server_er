const mongoose = require('mongoose');

const bobinaSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    metrosIniciales: { type: Number, required: true },
    metrosRestantes: { type: Number, required: true },
    estado: {
      type: String,
      enum: ['disponible', 'asignada', 'agotada', 'desecho'],
      default: 'disponible',
    },
    tareaActual: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Bobina', bobinaSchema);
