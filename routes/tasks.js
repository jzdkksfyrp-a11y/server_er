const express = require('express');
const Task = require('../models/Task');
const Bobina = require('../models/Bobina');
const Report = require('../models/Report');
const { verifyToken } = require('../middleware/auth');
const { optimizarCortes } = require('../utils/cableOptimizer');

const router = express.Router();
router.use(verifyToken);

// Lista de tareas: el empleado solo ve las suyas; admin y dom ven todas
router.get('/', async (req, res) => {
  const filtro = req.user.rol === 'empleado' ? { asignadoA: req.user.id } : {};
  const tareas = await Task.find(filtro)
    .select('-fotosReferencia -tiradas -bobinas') // Excluir datos pesados en la lista general
    .populate('asignadoA', 'nombre')
    .sort({ createdAt: -1 });
  res.json(tareas);
});

router.get('/:id', async (req, res) => {
  const tarea = await Task.findById(req.params.id)
    .populate('asignadoA', 'nombre')
    .populate('bobinas');
  if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });
  res.json(tarea);
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
  const updateFields = { estado: 'en_progreso' };
  if (tarea && !tarea.startedAt) {
    updateFields.startedAt = new Date();
  }
  await Task.findByIdAndUpdate(req.params.id, updateFields);
  
  const io = req.app.get('io');
  if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'nuevo_reporte' });

  res.status(201).json(report);
});

// Historico de avances de una tarea (lo usan empleado, admin y dom)
router.get('/:id/reports', async (req, res) => {
  const reports = await Report.find({ tarea: req.params.id })
    .populate('autor', 'nombre rol')
    .sort({ createdAt: 1 });
  res.json(reports);
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

module.exports = router;
