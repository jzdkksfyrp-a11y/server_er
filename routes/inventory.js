const express = require('express');
const Bobina = require('../models/Bobina');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Obtener inventario de bobinas
// Si se pasa ?estado=disponible, filtra por estado
router.get('/', async (req, res) => {
  try {
    const filtro = {};
    if (req.query.estado) {
      filtro.estado = req.query.estado;
    }
    const bobinas = await Bobina.find(filtro).populate('tareaActual', 'titulo');
    res.json(bobinas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar nueva bobina en inventario (solo admin o dom)
router.post('/', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  try {
    const { nombre, metrosIniciales } = req.body;
    const bobina = await Bobina.create({
      nombre,
      metrosIniciales,
      metrosRestantes: metrosIniciales,
      estado: 'disponible'
    });
    res.status(201).json(bobina);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Actualizar estado de una bobina (ej. marcarla como desecho manual)
router.patch('/:id', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  try {
    const { estado } = req.body;
    const bobina = await Bobina.findByIdAndUpdate(req.params.id, { estado }, { new: true });
    res.json(bobina);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
