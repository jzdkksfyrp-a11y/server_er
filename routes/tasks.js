const express = require('express');
const Task = require('../models/Task');
const Bobina = require('../models/Bobina');
const Report = require('../models/Report');
const { verifyToken } = require('../middleware/auth');
const { optimizarCortes } = require('../utils/cableOptimizer');
const { sendPushNotification } = require('./push');
const User = require('../models/User'); // Need User to find admins

const router = express.Router();
router.use(verifyToken);

// Lista de tareas: el empleado solo ve las suyas (hasta las 9pm si están terminadas); admin y dom ven activas
router.get('/', async (req, res) => {
  let filtro = {};
  if (req.user.rol === 'empleado') {
    const now = new Date();
    const currentHour = now.getHours();
    let cutoff = new Date(now);
    cutoff.setHours(21, 0, 0, 0);
    if (currentHour < 21) {
      cutoff.setDate(cutoff.getDate() - 1);
    }

    filtro = {
      asignadoA: req.user.id,
      $or: [
        { estado: { $ne: 'revisada' } },
        { estado: 'revisada', completedAt: { $gt: cutoff } }
      ]
    };
  } else {
    // Admin/Dom: Ocultar las tareas cerradas de la vista principal
    filtro = { estado: { $ne: 'revisada' } };
  }

  const tareas = await Task.find(filtro)
    .select('-fotosReferencia -tiradas -bobinas')
    .populate('asignadoA', 'nombre')
    .sort({ createdAt: -1 });
  res.json(tareas);
});

// Tareas cerradas (solo para admin/dom)
router.get('/historical', async (req, res) => {
  if (req.user.rol === 'empleado') return res.status(403).json({ error: 'Prohibido' });
  const tareas = await Task.find({ estado: 'revisada' })
    .select('titulo completedAt cotizacionFolio creadoPorEmpleado')
    .sort({ completedAt: -1 });
  res.json(tareas);
});

// ── NUEVO: Obtener bobinas asignadas al empleado logueado ────────────────────
// IMPORTANTE: Debe ir ANTES de /:id para que Express no confunda "mis-bobinas" con un _id
router.get('/mis-bobinas', async (req, res) => {
  try {
    const bobinas = await Bobina.find({ empleadoAsignado: req.user.id, estado: 'asignada', tareaActual: null });
    res.json(bobinas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const tarea = await Task.findById(req.params.id)
    .select('-fotosReferencia') // Excluir base64 pesada
    .populate('asignadoA', 'nombre')
    .populate('bobinas')
    .lean();
  
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });
  
  // Saber si tiene fotos de referencia para mostrar el boton
  const tareaCompleta = await Task.findById(req.params.id).select('fotosReferencia');
  tarea.tieneFotos = tareaCompleta.fotosReferencia && tareaCompleta.fotosReferencia.length > 0;
  
  res.json(tarea);
});

router.get('/:id/images', async (req, res) => {
  const tarea = await Task.findById(req.params.id).select('fotosReferencia');
  res.json(tarea ? tarea.fotosReferencia || [] : []);
});

// El instalador sube un comentario de avance (con fotos opcionales)
router.post('/:id/reports', async (req, res) => {
  const { comentario, fotos } = req.body;
  const report = await Report.create({
    tarea: req.params.id,
    autor: req.user.id,
    comentario,
    fotos: fotos || [],
  });
  
  const tarea = await Task.findById(req.params.id);
  const updateFields = { estado: 'enviada' };
  if (tarea && !tarea.startedAt) {
    updateFields.startedAt = new Date();
  }
  await Task.findByIdAndUpdate(req.params.id, updateFields);
  
  const io = req.app.get('io');
  if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'nuevo_reporte' });

  // Notificar a admins/dom
  try {
    const admins = await User.find({ rol: { $in: ['admin', 'socio'] } }); // socio == dom in naisata_db
    for (const admin of admins) {
      sendPushNotification(admin._id, {
        title: 'Nuevo Reporte',
        body: `El técnico ha subido un nuevo reporte en la tarea: ${tarea.titulo || ''}`,
        url: `/?id=${req.params.id}`
      });
    }
  } catch(e) {
    console.error('Error enviando push de reporte:', e);
  }

  res.status(201).json(report);
});

// Historico de avances de una tarea (sin imagenes pesadas)
router.get('/:id/reports', async (req, res) => {
  const reports = await Report.find({ tarea: req.params.id })
    .select('-fotos')
    .populate('autor', 'nombre rol')
    .sort({ createdAt: 1 })
    .lean();

  // Añadir flag tieneFotos consultando la base
  for (let r of reports) {
    const repObj = await Report.findById(r._id).select('fotos');
    r.tieneFotos = repObj.fotos && repObj.fotos.length > 0;
  }

  res.json(reports);
});

router.get('/:id/reports/:reportId/images', async (req, res) => {
  const report = await Report.findById(req.params.reportId).select('fotos');
  res.json(report ? report.fotos || [] : []);
});

// Admin o dom cambian el estado de la tarea (ej: marcar como revisada)
router.patch('/:id/status', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  const { estado } = req.body;
  const updateFields = { estado };
  if (estado === 'revisada') {
    updateFields.completedAt = new Date();
  }
  const tarea = await Task.findByIdAndUpdate(req.params.id, updateFields, { new: true });
  
  const io = req.app.get('io');
  if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'cambio_estado', estado });

  if (tarea.asignadoA) {
    let msgBody = `El estado de tu tarea cambió a ${estado}.`;
    if (estado === 'revisada') msgBody = 'Tu tarea ha sido aprobada (Visto Bueno).';
    if (estado === 'requiere_evidencia') msgBody = 'El administrador solicita más evidencia.';

    sendPushNotification(tarea.asignadoA, {
      title: 'Actualización de Tarea',
      body: msgBody,
      url: `/?id=${tarea._id}`
    });
  }

  res.json(tarea);
});

// Marcar tarea con entregable generado
router.patch('/:id/entregable', async (req, res) => {
  const tarea = await Task.findByIdAndUpdate(req.params.id, { entregableGenerado: true }, { new: true });
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });
  const io = req.app.get('io');
  if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'entregable_generado' });
  res.json(tarea);
});

// Añadir nueva tirada (Admin / Dom / Empleado)
router.post('/:id/tiradas', async (req, res) => {
  // Ya no restringimos a admin/dom
  const { nombre, categoria, metrosEstimados } = req.body;
  const tarea = await Task.findById(req.params.id);
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });

  tarea.tiradas.push({ nombre, categoria, metrosEstimados });
  
  // Reoptimizar todas las tiradas usando las bobinas actuales
  const { bobinas: bobinasOpt, tiradas: tiradasOpt } = optimizarCortes(tarea.bobinas, tarea.tiradas);
  tarea.bobinas = bobinasOpt;
  tarea.tiradas = tiradasOpt;

  await tarea.save();

  const io = req.app.get('io');
  if (io) {
    io.emit('task_updated', { taskId: req.params.id, tipo: 'nueva_tirada' });
    if (req.user.rol === 'empleado') {
      io.emit('nueva_tirada_empleado', { taskId: req.params.id, usuario: req.user.nombre, tareaNombre: tarea.titulo });
    }
  }

  res.status(201).json(tarea.tiradas[tarea.tiradas.length - 1]);
});

// Eliminar tirada (Admin / Dom / Empleado)
router.delete('/:id/tiradas/:index', async (req, res) => {
  try {
    const tarea = await Task.findById(req.params.id);
    if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (tarea.estado === 'revisada') {
      return res.status(400).json({ error: 'No se pueden modificar tiradas de una tarea ya revisada.' });
    }

    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index >= tarea.tiradas.length) {
      return res.status(400).json({ error: 'Índice de tirada inválido' });
    }

    tarea.tiradas.splice(index, 1);
    
    // Reoptimizar todas las tiradas usando las bobinas actuales
    const { bobinas: bobinasOpt, tiradas: tiradasOpt } = optimizarCortes(tarea.bobinas, tarea.tiradas);
    tarea.bobinas = bobinasOpt;
    tarea.tiradas = tiradasOpt;

    await tarea.save();

    const io = req.app.get('io');
    if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'tirada_eliminada' });

    res.json(tarea);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Añadir bobina existente del inventario a la tarea
router.post('/:id/bobinas', async (req, res) => {
  const { bobinaId } = req.body;
  const tarea = await Task.findById(req.params.id).populate('bobinas');
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });

  const bobina = await Bobina.findById(bobinaId);
  if (!bobina) return res.status(404).json({ error: 'Bobina no encontrada' });
  if (bobina.estado !== 'disponible') return res.status(400).json({ error: 'Bobina no está disponible' });

  bobina.estado = 'asignada';
  bobina.tareaActual = tarea._id;
  await bobina.save();

  tarea.bobinas.push(bobina._id);
  await tarea.save();
  
  // Re-fetch para poblar bobinas antes de optimizar
  const tareaPoblada = await Task.findById(req.params.id).populate('bobinas');

  // Reoptimizar todas las tiradas usando las nuevas bobinas
  const { bobinas: bobinasOpt, tiradas: tiradasOpt } = optimizarCortes(tareaPoblada.bobinas, tareaPoblada.tiradas);
  
  // Guardar estado optimizado de tiradas
  tareaPoblada.tiradas = tiradasOpt;
  await tareaPoblada.save();

  const io = req.app.get('io');
  if (io) {
    io.emit('task_updated', { taskId: req.params.id, tipo: 'nueva_bobina' });
    if (req.user.rol === 'empleado') {
      io.emit('nueva_bobina_empleado', { taskId: req.params.id, usuario: req.user.nombre, tareaNombre: tarea.titulo });
    }
  }

  res.status(201).json(bobina);
});


// Actualizar estado de una tirada (empleado u admin)
router.patch('/:id/tiradas/:tiradaId', async (req, res) => {
  const { cortado, metrosReales } = req.body;
  const tarea = await Task.findById(req.params.id).populate('bobinas');
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });

  const tirada = tarea.tiradas.id(req.params.tiradaId);
  if (!tirada) return res.status(404).json({ error: 'Tirada no encontrada' });

  const estabaCortado = tirada.cortado;
  if (cortado !== undefined) tirada.cortado = cortado;
  if (metrosReales !== undefined) tirada.metrosReales = metrosReales;

  // Si acaba de marcarse como cortado, descontamos de la bobina global
  if (cortado === true && !estabaCortado && tirada.bobinaAsignada && tirada.metrosReales) {
    const bobinaGlobal = tarea.bobinas.find(b => b.nombre === tirada.bobinaAsignada);
    if (bobinaGlobal) {
      bobinaGlobal.metrosRestantes -= tirada.metrosReales;
      if (bobinaGlobal.metrosRestantes <= 0) {
        bobinaGlobal.metrosRestantes = 0;
        bobinaGlobal.estado = 'agotada';
      }
      await bobinaGlobal.save();
    }
  }

  await tarea.save();

  const io = req.app.get('io');
  if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'tirada_actualizada' });

  res.json(tirada);
});

// Finalizar tarea (modal de retornos/desecho)
router.post('/:id/finalize', async (req, res) => {
  if (!['admin', 'dom'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }
  const { decisiones } = req.body; // { bobinaId: 'regresar' | 'desecho' }
  const tarea = await Task.findById(req.params.id);
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });

  for (const bobinaId of tarea.bobinas) {
    const decision = decisiones[bobinaId];
    if (decision) {
      const nuevoEstado = decision === 'regresar' ? 'disponible' : 'desecho';
      await Bobina.findByIdAndUpdate(bobinaId, { 
        estado: nuevoEstado, 
        tareaActual: null 
      });
    }
  }

  tarea.estado = 'revisada';
  tarea.completedAt = new Date();
  await tarea.save();

  const io = req.app.get('io');
  if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'cambio_estado', estado: 'revisada' });

  res.json(tarea);
});


// ── NUEVO: Empleado crea su propia tarea con bobinas que ya tiene asignadas ──
// El empleado reporta qué hizo, dónde, qué tiradas cortó y sube evidencia
router.post('/employee-quick-task', async (req, res) => {
  // Solo empleados
  if (req.user.rol !== 'empleado') {
    return res.status(403).json({ error: 'Solo empleados pueden usar este endpoint' });
  }
  try {
    const { titulo, descripcion, tiradas, bobinaIds, fotosReferencia } = req.body;
    if (!titulo || !descripcion) {
      return res.status(400).json({ error: 'Título y descripción son requeridos' });
    }

    // Las bobinas que el empleado usa deben estar asignadas a él
    let bobinasCompletas = [];
    if (bobinaIds && bobinaIds.length > 0) {
      bobinasCompletas = await Bobina.find({
        _id: { $in: bobinaIds },
        empleadoAsignado: req.user.id,
        estado: 'asignada',
        tareaActual: null
      });
    }

    // Correr optimizador con las bobinas y tiradas del empleado
    const { tiradas: tiradasOpt } = optimizarCortes(bobinasCompletas, tiradas || []);

    const task = await Task.create({
      titulo,
      descripcion,
      prioridad: 'media',
      asignadoA: req.user.id,
      creadoPor: req.user.id,
      creadoPorEmpleado: true,
      bobinas: bobinasCompletas.map(b => b._id),
      tiradas: tiradasOpt,
      fotosReferencia: fotosReferencia || [],
      estado: 'en_progreso',
      startedAt: new Date(),
    });

    // Ligar las bobinas a esta nueva tarea para que no se reutilicen
    if (bobinasCompletas.length > 0) {
      await Bobina.updateMany(
        { _id: { $in: bobinasCompletas.map(b => b._id) } },
        { $set: { tareaActual: task._id } }
      );
    }

    const io = req.app.get('io');
    if (io) io.emit('new_task', task);

    // Notificar a admins que el empleado creó una tarea propia
    try {
      const admins = await User.find({ rol: { $in: ['admin', 'dom'] } });
      for (const admin of admins) {
        sendPushNotification(admin._id, {
          title: '⚡ Trabajo registrado por empleado',
          body: `${req.user.nombre} creó la tarea "${titulo}" usando sus bobinas asignadas.`,
          url: `/?id=${task._id}`
        });
      }
    } catch(e) {}

    res.status(201).json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── NUEVO: Empleado marca como finalizado su propio trabajo ─────────────────
// Dispara la misma lógica que el admin: marca bobinas usadas y cierra la tarea
router.post('/:id/employee-finalize', async (req, res) => {
  if (req.user.rol !== 'empleado') {
    return res.status(403).json({ error: 'Solo empleados pueden usar este endpoint' });
  }
  try {
    const { decisiones, comentarioCierre } = req.body; // decisiones: { bobinaId: 'regresar' | 'desecho' }
    const tarea = await Task.findById(req.params.id);
    if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (String(tarea.asignadoA) !== String(req.user.id)) {
      return res.status(403).json({ error: 'No tienes permiso para finalizar esta tarea' });
    }

    // Aplicar decisiones sobre las bobinas (regresar al almacén o desechar)
    for (const bobinaId of tarea.bobinas) {
      const decision = decisiones ? decisiones[bobinaId] : 'regresar';
      const nuevoEstado = decision === 'desecho' ? 'desecho' : 'disponible';
      await Bobina.findByIdAndUpdate(bobinaId, {
        estado: nuevoEstado,
        tareaActual: null,
        empleadoAsignado: null
      });
    }

    tarea.estado = 'enviada'; // El admin la revisará y dará visto bueno
    tarea.completedAt = new Date();
    if (comentarioCierre) tarea.comentarioCierre = comentarioCierre;
    await tarea.save();

    const io = req.app.get('io');
    if (io) io.emit('task_updated', { taskId: tarea._id.toString(), tipo: 'cambio_estado', estado: 'enviada' });

    // Notificar a admins
    try {
      const admins = await User.find({ rol: { $in: ['admin', 'dom'] } });
      for (const admin of admins) {
        sendPushNotification(admin._id, {
          title: '✅ Trabajo finalizado por empleado',
          body: `${req.user.nombre} marcó como finalizado el trabajo: "${tarea.titulo}". Requiere tu revisión.`,
          url: `/?id=${tarea._id}`
        });
      }
    } catch(e) {}

    res.json(tarea);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
