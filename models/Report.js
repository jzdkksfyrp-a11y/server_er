const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    tarea: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    autor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    comentario: { type: String, required: true },
    fotos: [{ type: String }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
