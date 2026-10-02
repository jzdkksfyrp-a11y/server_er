const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Task = require('../models/Task');
const Bobina = require('../models/Bobina');
const { adminOrApiKey } = require('../middleware/auth');
const { optimizarCortes } = require('../utils/cableOptimizer');
const { sendPushNotification } = require('./push');
const {
  ORIGEN, ROLES, PASSWORD_MIN, FILTRO_APP_IT,
  normalizarUsername, validarNuevoUsuario, existeIdentidad,
} = require('../utils/usuariosAppIt');

const router = express.Router();

// Todo lo que hay aqui abajo lo puede usar el frontend (admin logueado)
// o el sistema externo a.naisata.com con el header x-api-key
router.use(adminOrApiKey);

// Crear usuario (empleado, dom o admin)
// Los usuarios de app-it quedan marcados con origen:'app-it' y un usernameKey único,
// y nunca pueden coincidir con ninguna otra cuenta de la base (CRM incluido).
router.post('/users', async (req, res) => {
  try {
    const body = req.body || {};
    const username = normalizarUsername(body.username);
    const nombre = String(body.nombre || '').trim();
    const password = typeof body.password === 'string' ? body.password : '';
    const rol = String(body.rol || '').trim();

    const errorValidacion = validarNuevoUsuario({ username, password, nombre, rol });
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    if (await existeIdentidad(username)) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de usuario. Elige otro.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const datos = {
      username,
      usernameKey: username,
      password: hash,
      nombre,
      rol,
      origen: ORIGEN,
      estadoCuenta: 'activa',
      activo: true,
    };
    // Con la API key externa no hay un id de usuario real
    if (mongoose.isValidObjectId(req.user.id)) datos.creadoPor = req.user.id;

    const user = await User.create(datos);
    res.status(201).json({ id: user._id, username: user.username, nombre: user.nombre, rol: user.rol, creadoPor: user.creadoPor });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de usuario. Elige otro.' });
    }
    console.error('Error creando usuario:', err);
    res.status(500).json({ error: 'No se pudo crear el usuario' });
  }
});

// Listar usuarios (para el selector de "asignar a" en crear tarea). Solo usuarios de app-it.
router.get('/users', async (req, res) => {
  try {
    const users = await User.find(FILTRO_APP_IT, '-password').sort({ nombre: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// Editar usuario (solo usuarios de app-it, nunca cuentas del CRM)
router.put('/users/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { nombre, rol, password } = req.body || {};
    if (rol && !ROLES.includes(rol)) {
      return res.status(400).json({ error: 'Rol invalido' });
    }
    const updateData = {};
    if (nombre) updateData.nombre = String(nombre).trim().slice(0, 100);
    if (rol) updateData.rol = rol;
    if (password) {
      if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
        return res.status(400).json({ error: `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.` });
      }
      updateData.password = await bcrypt.hash(password, 10);
    }
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, ...FILTRO_APP_IT },
      { $set: updateData },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'No se pudo editar el usuario', detalle: err.message });
  }
});

// Eliminar usuario (solo usuarios de app-it)
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = await User.findOneAndDelete({ _id: req.params.id, ...FILTRO_APP_IT });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
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


// Asignar folio de cotización a una tarea terminada (solo admin)
router.patch('/tasks/:id/folio', async (req, res) => {
  try {
    const { cotizacionFolio } = req.body;
    if (!cotizacionFolio) return res.status(400).json({ error: 'Se requiere el folio' });
    const task = await Task.findByIdAndUpdate(req.params.id, { cotizacionFolio }, { new: true });
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancelar asignación de bobina a empleado (sin tarea) - regresa a disponible
router.post('/bobina-desasignar/:id', async (req, res) => {
  try {
    const bobina = await Bobina.findById(req.params.id);
    if (!bobina) return res.status(404).json({ error: 'Bobina no encontrada' });
    if (bobina.estado !== 'asignada' || bobina.tareaActual) {
      return res.status(400).json({ error: 'Solo puedes desasignar bobinas asignadas directamente a un empleado (sin tarea activa).' });
    }
    bobina.estado = 'disponible';
    bobina.empleadoAsignado = null;
    await bobina.save();
    res.json(bobina);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
