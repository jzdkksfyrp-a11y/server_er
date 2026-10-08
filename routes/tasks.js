const express = require('express');
const mongoose = require('mongoose');
const Task = require('../models/Task');
const Bobina = require('../models/Bobina');
const Report = require('../models/Report');
const { verifyToken } = require('../middleware/auth');
const { optimizarCortes } = require('../utils/cableOptimizer');
const { sendPushNotification } = require('./push');
const User = require('../models/User'); // Need User to find admins

const router = express.Router();
router.use(verifyToken);

// ── Helpers de bobinas en sitio / externas ───────────────────────────────────
const TOPE_METROS_BOBINA = Number(process.env.TOPE_METROS_BOBINA) || 10000;
const CATEGORIAS_CABLE = ['utp_cat5e', 'utp_cat6', 'utp_cat6a', 'fibra_monomodo', 'fibra_multimodo', 'control_acceso', 'audio', 'otro'];
const CABLES_TIRADA = CATEGORIAS_CABLE;
const esStaff = (u) => ['admin', 'dom'].includes(u.rol);
const esAsignado = (u, t) => String(t.asignadoA) === String(u.id);
// Permiso heredado: antes "Permitir extras" vivía como texto dentro de la descripción
const extrasHeredado = (t) => !!t.permitirExtras || /\[Permitir extras:\s*SI\]/i.test(t.descripcion || '');
// Quién puede registrar/quitar bobinas: admin/dom siempre; el empleado solo si es el asignado y la tarea lo permite
const puedeGestionarBobinas = (u, t) =>
  esStaff(u) || (esAsignado(u, t) && (!!t.bobinasEnSitio || !!t.permiteRegistrarBobinas || extrasHeredado(t)));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const manejarError = (res, err) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error('[tasks]', err);
  return res.status(err && err.name === 'ValidationError' ? 400 : 500).json({ error: err.message || 'Error interno' });
};

// Evita CastError (y peticiones colgadas) cuando el :id no es un ObjectId válido
router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Tarea no encontrada' });
  next();
});

const resumirCalculo = (stats) => {
  const ligera = (t) => ({ _id: t._id, nombre: t.nombre, cableRequerido: t.cableRequerido, metrosEstimados: t.metrosEstimados });
  return {
    esSuficiente: !!stats.esSuficiente,
    sinBobinas: !!stats.sinBobinas,
    metrosFaltantes: stats.metrosFaltantes || 0,
    faltantesPorTipo: stats.faltantesPorTipo || {},
    tiradasSinCable: (stats.tiradasSinCable || []).map(ligera),
    tiradasPendientesBobina: (stats.tiradasPendientesBobina || []).map(ligera),
    totalSobrante: stats.totalSobrante || 0,
    bobinasSinUso: (stats.bobinasSinUsar || []).map(b => b.nombre),
  };
};

// Cierre: a dónde va cada bobina. Las externas se devuelven al cliente ('devuelta') o se desechan.
async function origenPorBobina(ids) {
  const docs = await Bobina.find({ _id: { $in: ids } }).select('origen');
  const m = {};
  docs.forEach(d => { m[String(d._id)] = d.origen || 'inventario'; });
  return m;
}
const destinoBobina = (origen, regresar) => (!regresar ? 'desecho' : (origen === 'externa' ? 'devuelta' : 'disponible'));

// Carga la tarea con las bobinas pobladas, aplica `mutar` (opcional), corre el optimizador y guarda las
// tiradas SIN sobrescribir tarea.bobinas. Todas las rutas que cambian bobinas o tiradas pasan por aquí.
async function recalcularTarea(tareaId, mutar) {
  const tarea = await Task.findById(tareaId).populate('bobinas');
  if (!tarea) throw httpError(404, 'Tarea no encontrada');
  if (mutar) await mutar(tarea);
  if ((tarea.bobinas || []).some(b => !b || !b.nombre)) await tarea.populate('bobinas');
  const { tiradas, stats } = optimizarCortes(tarea.bobinas, tarea.tiradas);
  tarea.tiradas = tiradas;
  await tarea.save();
  return { tarea, resumen: resumirCalculo(stats) };
}

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
  try {
    const { nombre, categoria, metrosEstimados, cableRequerido } = req.body || {};
    const metros = Number(metrosEstimados);
    if (!nombre || !categoria || !(metros > 0)) return res.status(400).json({ error: 'Nombre, categoría y metros (mayores a cero) son requeridos' });
    if (cableRequerido && !CABLES_TIRADA.includes(cableRequerido)) return res.status(400).json({ error: 'Tipo de cable inválido' });

    const _id = new mongoose.Types.ObjectId();
    const { tarea, resumen } = await recalcularTarea(req.params.id, (t) => {
      if (t.estado === 'revisada') throw httpError(400, 'No se pueden modificar tiradas de una tarea ya revisada.');
      const nueva = { _id, nombre, categoria, metrosEstimados: metros };
      if (cableRequerido) nueva.cableRequerido = cableRequerido;   // si no llega se conserva el valor por defecto actual
      t.tiradas.push(nueva);
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('task_updated', { taskId: req.params.id, tipo: 'nueva_tirada' });
      if (req.user.rol === 'empleado') {
        io.emit('nueva_tirada_empleado', { taskId: req.params.id, usuario: req.user.nombre, tareaNombre: tarea.titulo });
      }
    }
    const tirada = tarea.tiradas.id(_id);
    res.status(201).json({ ...(tirada ? tirada.toObject() : {}), resumen });
  } catch (err) { manejarError(res, err); }
});

// Eliminar tirada (Admin / Dom / Empleado)
router.delete('/:id/tiradas/:index', async (req, res) => {
  try {
    const { tarea, resumen } = await recalcularTarea(req.params.id, (t) => {
      if (t.estado === 'revisada') throw httpError(400, 'No se pueden modificar tiradas de una tarea ya revisada.');
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0 || index >= t.tiradas.length) throw httpError(400, 'Índice de tirada inválido');
      t.tiradas.splice(index, 1);
    });
    const io = req.app.get('io');
    if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'tirada_eliminada' });
    res.json({ ...tarea.toObject(), resumen });
  } catch (err) { manejarError(res, err); }
});

// Añadir bobina existente del inventario a la tarea
router.post('/:id/bobinas', async (req, res) => {
  try {
    const { bobinaId } = req.body || {};
    if (!mongoose.isValidObjectId(bobinaId)) return res.status(404).json({ error: 'Bobina no encontrada' });
    const base = await Task.findById(req.params.id).select('asignadoA estado');
    if (!base) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (!esStaff(req.user) && !esAsignado(req.user, base)) return res.status(403).json({ error: 'No tienes permiso para agregar bobinas a esta tarea' });
    if (base.estado === 'revisada') return res.status(400).json({ error: 'No se pueden modificar bobinas de una tarea ya revisada.' });

    const bobina = await Bobina.findById(bobinaId);
    if (!bobina) return res.status(404).json({ error: 'Bobina no encontrada' });
    if (bobina.estado !== 'disponible' || bobina.origen === 'externa') return res.status(400).json({ error: 'Bobina no está disponible' });

    bobina.estado = 'asignada';
    bobina.tareaActual = base._id;
    bobina.metrosAlAsignar = bobina.metrosRestantes;   // base del cálculo (resuelve el sobreestimado de bobinas ya usadas)
    await bobina.save();

    const { tarea, resumen } = await recalcularTarea(req.params.id, (t) => { t.bobinas.push(bobina); });

    const io = req.app.get('io');
    if (io) {
      io.emit('task_updated', { taskId: req.params.id, tipo: 'nueva_bobina' });
      if (req.user.rol === 'empleado') {
        io.emit('nueva_bobina_empleado', { taskId: req.params.id, usuario: req.user.nombre, tareaNombre: tarea.titulo });
      }
    }
    res.status(201).json({ ...bobina.toObject(), resumen });
  } catch (err) { manejarError(res, err); }
});

// Registrar una bobina que NO está en el inventario (p. ej. la pone el cliente en sitio)
router.post('/:id/bobinas/externa', async (req, res) => {
  let creada = null;
  try {
    const base = await Task.findById(req.params.id).populate('bobinas', 'nombre');
    if (!base) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (!puedeGestionarBobinas(req.user, base)) return res.status(403).json({ error: 'No tienes permiso para registrar bobinas en esta tarea' });
    if (base.estado === 'revisada') return res.status(400).json({ error: 'No se pueden modificar bobinas de una tarea ya revisada.' });

    const nombre = String((req.body || {}).nombre || '').trim().slice(0, 80);
    const categoria = (req.body || {}).categoria;
    const metros = Number((req.body || {}).metrosIniciales);
    if (!nombre) return res.status(400).json({ error: 'El nombre de la bobina es obligatorio' });
    if (!CATEGORIAS_CABLE.includes(categoria)) return res.status(400).json({ error: 'Tipo de cable inválido' });
    if (!(metros > 0) || metros > TOPE_METROS_BOBINA) return res.status(400).json({ error: `Los metros deben ser mayores a 0 y menores o iguales a ${TOPE_METROS_BOBINA}` });
    if ((base.bobinas || []).some(b => b && String(b.nombre).trim().toLowerCase() === nombre.toLowerCase())) {
      return res.status(409).json({ error: `Ya hay una bobina llamada "${nombre}" en esta tarea. Usa otro nombre.` });
    }

    creada = await Bobina.create({
      nombre, categoria, origen: 'externa', estado: 'asignada',
      metrosIniciales: metros, metrosRestantes: metros, metrosAlAsignar: metros,
      tareaActual: base._id, empleadoAsignado: base.asignadoA,
      // sin folio: las externas no llevan folio (el índice único es sparse)
    });
    const { tarea, resumen } = await recalcularTarea(req.params.id, (t) => { t.bobinas.push(creada); });

    const io = req.app.get('io');
    if (io) {
      io.emit('task_updated', { taskId: req.params.id, tipo: 'nueva_bobina' });
      if (req.user.rol === 'empleado') {
        io.emit('nueva_bobina_empleado', { taskId: req.params.id, usuario: req.user.nombre, tareaNombre: tarea.titulo });
      }
    }
    res.status(201).json({ bobina: creada, resumen });
  } catch (err) {
    if (creada) await Bobina.findByIdAndDelete(creada._id).catch(() => {});   // no dejar una externa huérfana
    manejarError(res, err);
  }
});

// Quitar una bobina de la tarea (por error de captura). Se bloquea si ya hay cortes en ella.
router.delete('/:id/bobinas/:bobinaId', async (req, res) => {
  try {
    const { bobinaId } = req.params;
    if (!mongoose.isValidObjectId(bobinaId)) return res.status(404).json({ error: 'Bobina no encontrada' });
    let quitada = null;
    const { tarea, resumen } = await recalcularTarea(req.params.id, (t) => {
      if (!puedeGestionarBobinas(req.user, t)) throw httpError(403, 'No tienes permiso para quitar bobinas de esta tarea');
      if (t.estado === 'revisada') throw httpError(400, 'No se pueden modificar bobinas de una tarea ya revisada.');
      quitada = t.bobinas.find(b => String(b._id) === bobinaId);
      if (!quitada) throw httpError(404, 'Esa bobina no pertenece a la tarea');
      const conCortes = t.tiradas.some(x => x.cortado && (String(x.bobinaId || '') === bobinaId || (!x.bobinaId && x.bobinaAsignada === quitada.nombre)));
      if (conCortes) throw httpError(409, 'No se puede quitar la bobina: ya tiene tiradas cortadas.');
      t.bobinas = t.bobinas.filter(b => String(b._id) !== bobinaId);
    });
    if (quitada.origen === 'externa') await Bobina.findByIdAndDelete(bobinaId);
    else await Bobina.findByIdAndUpdate(bobinaId, { $set: { estado: 'disponible' }, $unset: { tareaActual: '', metrosAlAsignar: '' } });

    const io = req.app.get('io');
    if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'bobina_quitada' });
    res.json({ success: true, resumen });
  } catch (err) { manejarError(res, err); }
});

// Recalcular manualmente ("Calcular y acomodar")
router.post('/:id/recalcular', async (req, res) => {
  try {
    const { tarea, resumen } = await recalcularTarea(req.params.id, (t) => {
      if (!esStaff(req.user) && !esAsignado(req.user, t)) throw httpError(403, 'No tienes permiso');
      if (t.estado === 'revisada') throw httpError(400, 'No se puede recalcular una tarea ya revisada.');
    });
    const io = req.app.get('io');
    if (io) io.emit('task_updated', { taskId: req.params.id, tipo: 'recalculada' });
    res.json({ resumen, tiradas: tarea.tiradas });
  } catch (err) { manejarError(res, err); }
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
    const bobinaGlobal = (tirada.bobinaId && tarea.bobinas.find(b => String(b._id) === String(tirada.bobinaId)))
      || tarea.bobinas.find(b => b.nombre === tirada.bobinaAsignada);
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

  const origenes = await origenPorBobina(tarea.bobinas);
  for (const bobinaId of tarea.bobinas) {
    const decision = (decisiones || {})[bobinaId];
    if (decision) {
      // Externas (del cliente): regresar = devolver al cliente. NUNCA pasan a disponible.
      const nuevoEstado = destinoBobina(origenes[bobinaId], decision === 'regresar');
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

    // Correr optimizador con las bobinas y tiradas del empleado (base = metros que tiene cada bobina hoy)
    const paraCalculo = bobinasCompletas.map(b => ({ _id: b._id, nombre: b.nombre, categoria: b.categoria, metrosIniciales: b.metrosIniciales, metrosAlAsignar: b.metrosRestantes }));
    const { tiradas: tiradasOpt } = optimizarCortes(paraCalculo, tiradas || []);

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
      await Bobina.bulkWrite(bobinasCompletas.map(b => ({
        updateOne: { filter: { _id: b._id }, update: { $set: { tareaActual: task._id, metrosAlAsignar: b.metrosRestantes } } }
      })));
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
    const origenes = await origenPorBobina(tarea.bobinas);
    for (const bobinaId of tarea.bobinas) {
      const decision = decisiones ? decisiones[bobinaId] : 'regresar';
      const nuevoEstado = destinoBobina(origenes[bobinaId], decision !== 'desecho');
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
