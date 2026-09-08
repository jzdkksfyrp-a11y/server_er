const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    titulo: { type: String, required: true },
    descripcion: { type: String, required: true },
    prioridad: { type: String, enum: ['alta', 'media', 'baja'], default: 'media' },
    ubicacion: { type: String },
    contacto: { type: String }, // numero de contacto en el sitio
    fotosReferencia: [{ type: String }], // URLs o imagenes en base64
    asignadoA: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cotizacionId: { type: String, default: '' },
    entregableGenerado: { type: Boolean, default: false },
    estado: {
      type: String,
      enum: ['pendiente', 'en_progreso', 'enviada', 'requiere_evidencia', 'revisada'],
      default: 'pendiente',
    },
    bobinas: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bobina' }],
    tiradas: [{
      nombre: { type: String, required: true },
      categoria: { type: String, enum: ['camaras', 'aps', 'nodos', 'control_acceso'], required: true },
      metrosEstimados: { type: Number, required: true },
      metrosReales: { type: Number, default: 0 },
      cortado: { type: Boolean, default: false },
      bobinaAsignada: { type: String, default: null } // Nombre de la bobina de donde se cortará
    }],
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Task', taskSchema);
