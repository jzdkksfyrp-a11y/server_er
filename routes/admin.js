const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Task = require('../models/Task');
const Bobina = require('../models/Bobina');
const { adminOrApiKey } = require('../middleware/auth');
const { optimizarCortes } = require('../utils/cableOptimizer');
const { sendPushNotification } = require('./push');

const router = express.Router();

// Todo lo que hay aqui abajo lo puede usar el frontend (admin logueado)
// o el sistema externo a.naisata.com con el header x-api-key
router.use(adminOrApiKey);

// Crear usuario (empleado, dom o admin)
router.post('/users', async (req, res) => {
  try {
    const { username, password, nombre, rol } = req.body;
    if (!['empleado', 'dom', 'admin'].includes(rol)) {
      return res.status(400).json({ error: 'Rol invalido' });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash, nombre, rol });
    res.status(201).json({ id: user._id, username: user.username, nombre: user.nombre, rol: user.rol });
  } catch (err) {
    res.status(400).json({ error: 'No se pudo crear el usuario', detalle: err.message });
  }
});

// Listar usuarios (para el selector de "asignar a" en crear tarea)
router.get('/users', async (req, res) => {
  const users = await User.find({}, '-password').sort({ nombre: 1 });
  res.json(users);
});

// Editar usuario
router.put('/users/:id', async (req, res) => {
  try {
    const { nombre, rol, password } = req.body;
    if (rol && !['empleado', 'dom', 'admin'].includes(rol)) {
      return res.status(400).json({ error: 'Rol invalido' });
    }
    const updateData = {};
    if (nombre) updateData.nombre = nombre;
    if (rol) updateData.rol = rol;
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }
    const user = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).select('-password');
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'No se pudo editar el usuario', detalle: err.message });
  }
});

// Eliminar usuario
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'No se pudo eliminar el usuario', detalle: err.message });
  }
});

// Crear tarea con todos sus detalles
router.post('/tasks', async (req, res) => {
  try {
    const { titulo, descripcion, prioridad, ubicacion, contacto, fotosReferencia, asignadoA, tiradas, bobinaIds, cotizacionId } = req.body;
    
    // Obtener las bobinas completas desde la base de datos
    let bobinasCompletas = [];
    if (bobinaIds && bobinaIds.length > 0) {
      bobinasCompletas = await Bobina.find({ _id: { $in: bobinaIds }, estado: 'disponible' });
    }

    // Correr motor de optimización si hay tiradas y bobinas
    const { bobinas: bobinasOpt, tiradas: tiradasOpt } = optimizarCortes(bobinasCompletas, tiradas || []);

    const task = await Task.create({
      titulo,
      descripcion,
      prioridad,
      ubicacion,
      contacto,
      fotosReferencia: fotosReferencia || [],
      asignadoA,
      cotizacionId: cotizacionId || '',
      bobinas: bobinasCompletas.map(b => b._id),
      tiradas: tiradasOpt,
      creadoPor: req.user.esIntegracionExterna ? undefined : req.user.id,
    });

    // Actualizar estado de las bobinas a 'asignada'
    if (bobinasCompletas.length > 0) {
      await Bobina.updateMany(
        { _id: { $in: bobinasCompletas.map(b => b._id) } },
        { $set: { estado: 'asignada', tareaActual: task._id } }
      );
    }

    const io = req.app.get('io');
    if (io) io.emit('new_task', task);

    // Mandar push al asignado
    sendPushNotification(asignadoA, {
      title: 'Nueva Tarea Asignada',
      body: `Te han asignado la tarea: ${titulo}`,
      url: `/?id=${task._id}`
    });

    res.status(201).json(task);
  } catch (err) {
    res.status(400).json({ error: 'No se pudo crear la tarea', detalle: err.message });
  }
});

// Eliminar tarea (solo admin)
router.delete('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    
    // Liberar bobinas asignadas
    if (task.bobinas && task.bobinas.length > 0) {
      await Bobina.updateMany(
        { _id: { $in: task.bobinas } },
        { $set: { estado: 'disponible' }, $unset: { tareaActual: "" } }
      );
    }
    
    await Task.findByIdAndDelete(req.params.id);
    
    const io = req.app.get('io');
    if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'borrada' });
    
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'No se pudo eliminar la tarea', detalle: err.message });
  }
});

module.exports = router;
