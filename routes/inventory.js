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
    const bobinas = await Bobina.find(filtro)
      .populate('tareaActual', 'titulo')
      .populate('empleadoAsignado', 'nombre');
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

// Asignar bobina directo a un empleado
router.post('/:id/asignar-empleado', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  try {
    const { empleadoId } = req.body;
    const bobina = await Bobina.findByIdAndUpdate(req.params.id, { 
      estado: 'asignada', 
      empleadoAsignado: empleadoId,
      tareaActual: null 
    }, { new: true });
    res.json(bobina);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Editar bobina
router.put('/:id', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  try {
    const { nombre, metrosIniciales } = req.body;
    const bobina = await Bobina.findById(req.params.id);
    if (!bobina) return res.status(404).json({ error: 'Bobina no encontrada' });
    
    // Solo permitir edición si está disponible (por simplicidad matemática)
    if (bobina.estado !== 'disponible') {
      return res.status(400).json({ error: 'Solo puedes editar bobinas que están disponibles en almacén' });
    }

    bobina.nombre = nombre || bobina.nombre;
    bobina.metrosIniciales = metrosIniciales || bobina.metrosIniciales;
    bobina.metrosRestantes = bobina.metrosIniciales; // Reset
    await bobina.save();
    res.json(bobina);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Eliminar bobina
router.delete('/:id', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  try {
    const bobina = await Bobina.findById(req.params.id);
    if (!bobina) return res.status(404).json({ error: 'Bobina no encontrada' });

    if (bobina.estado === 'asignada') {
      return res.status(400).json({ error: 'No puedes eliminar una bobina que actualmente está asignada a una tarea.' });
    }
    
    await Bobina.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
