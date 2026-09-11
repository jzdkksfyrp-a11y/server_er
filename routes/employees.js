const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const EmployeeProfile = require('../models/EmployeeProfile');
const EmployeeDocument = require('../models/EmployeeDocument');
const EmployeeAudit = require('../models/EmployeeAudit');
const { verifyToken, requireRole, verifyApiKey } = require('../middleware/auth');

const router = express.Router();
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const CRM_PERMISSIONS = [
  ['dashboard.ver', 'Panel principal'],
  ['cotizaciones.ver', 'Ver cotizaciones'], ['cotizaciones.editar', 'Crear y editar cotizaciones'],
  ['precios.ver', 'Ver tabulador'], ['precios.editar', 'Administrar tabulador'],
  ['proyectos.ver', 'Ver proyectos'], ['proyectos.editar', 'Administrar proyectos'],
  ['tareas.ver', 'Ver tareas'], ['tareas.editar', 'Administrar tareas'],
  ['agenda.ver', 'Ver agenda'], ['agenda.editar', 'Administrar agenda'],
  ['entregables.ver', 'Ver entregables'], ['entregables.crear', 'Crear entregables'],
  ['correo.ver', 'Consultar correo'], ['correo.enviar', 'Enviar correo'],
  ['tracking.ver', 'Ver tracking e inventario'], ['tracking.operar', 'Operar tracking e inventario'],
  ['finanzas.ver', 'Ver finanzas'], ['finanzas.editar', 'Administrar finanzas'],
];
const VALID_PERMISSIONS = new Set(CRM_PERMISSIONS.map(([key]) => key));
const VALID_ACCOUNT_STATES = new Set(['pendiente', 'activa', 'inactiva', 'suspendida', 'revocada']);

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function defaultPermissions(role) {
  if (role === 'admin') return CRM_PERMISSIONS.map(([key]) => key);
  if (role === 'socio') return ['dashboard.ver', 'cotizaciones.ver', 'cotizaciones.editar', 'precios.ver', 'proyectos.ver', 'proyectos.editar', 'tareas.ver', 'tareas.editar', 'agenda.ver', 'agenda.editar', 'entregables.ver', 'entregables.crear', 'correo.ver', 'correo.enviar', 'tracking.ver', 'tracking.operar'];
  return ['dashboard.ver', 'tareas.ver', 'entregables.ver'];
}

async function audit(req, empleadoId, accion, detalle = '', metadatos = {}) {
  try {
    await EmployeeAudit.create({ empleadoId: String(empleadoId), actorId: String(req.user?.id || 'sistema'), accion, detalle, metadatos });
  } catch (error) { console.error('[Expedientes] No se pudo guardar auditoría:', error.message); }
}

// server_2 define `_id` de users como String, mientras que otras versiones de
// la app lo crean como ObjectId. Consultamos la colección nativa para no
// convertir el ID recibido en la sesión ni perder compatibilidad entre ambos.
async function findCRMUser(userId, projection = {}) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const users = mongoose.connection.db.collection('users');
  // El CRM histórico ha usado ambos tipos de _id. Nunca envíes un selector
  // mixto al driver: primero consulta exactamente el valor de la sesión y,
  // únicamente si no existe, usa ObjectId como compatibilidad.
  let user = await users.findOne({ _id: id }, { projection });
  if (!user && mongoose.isValidObjectId(id)) {
    user = await users.findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection });
  }
  return user;
}

// El CRM de escritorio aún no emite JWT. Se mantiene una ruta de transición
// con el id de un administrador ya autenticado; para integraciones/producción
// se recomienda siempre JWT o x-api-key. El expediente solo es administrable
// por el rol admin (no por socios ni empleados).
async function requireHRManager(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return verifyToken(req, res, () => requireRole('admin')(req, res, next));
  }
  if (req.headers['x-api-key']) return verifyApiKey(req, res, next);

  try {
    const actorId = req.headers['x-crm-user-id'];
    if (!actorId) return res.status(401).json({ error: 'Se requiere una sesión de administrador.' });
    const actor = await findCRMUser(actorId, { rol: 1, role: 1, estadoCuenta: 1, activo: 1 });
    const active = actor && (typeof actor.activo === 'boolean' ? actor.activo : actor.estadoCuenta !== 'inactiva');
    const actorRole = String(actor?.rol || actor?.role || '').trim();
    if (!active || actorRole.toLowerCase() !== 'admin') {
      return res.status(403).json({
        error: !active
          ? 'Tu cuenta está inactiva en la base de datos de server_a.'
          : `Esta sesión tiene el rol "${actorRole || 'sin rol'}" en server_a; los expedientes requieren rol admin.`
      });
    }
    req.user = { id: actor._id, rol: actor.rol };
    next();
  } catch (error) {
    console.error('[Expedientes] No se pudo validar la sesión:', error.message);
    res.status(503).json({ error: 'No fue posible validar la sesión porque server_a no puede consultar MongoDB. Revisa MONGODB_URI en el servicio de Render.' });
  }
}

router.use(requireHRManager);

function publicUser(user) {
  const raw = user.toObject ? user.toObject() : user;
  const { password, tokenPortal, __v, ...safe } = raw;
  return safe;
}

function profilePayload(profile) {
  return profile ? profile.toObject() : {};
}

function cleanEmployee(user) {
  return publicUser(user || {});
}

// Los empleados ya existentes guardan parte del expediente directamente en
// users. Se usan como valores iniciales hasta que el administrador complete el
// perfil nuevo, sin mover ni sobrescribir datos históricos.
function legacyProfileValues(user) {
  return {
    fechaIngreso: user.fechaIngreso || null,
    nss: user.nss || '',
    rfc: user.rfc || '',
    numeroEmpleado: user.numeroEmpleado || '',
  };
}

function legacyDocuments(user) {
  return Array.isArray(user.documentos) ? user.documentos.map(document => ({
    _id: String(document?._id || ''),
    nombre: String(document?.nombre || 'Documento histórico'),
    tipo: 'Documento histórico',
    url: String(document?.url || ''),
    fecha: document?.fecha || null,
    legacy: true,
  })) : [];
}

function dateOrUndefined(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

router.get('/', async (req, res) => {
  try {
    const users = await mongoose.connection.db.collection('users').find({}).sort({ nombre: 1, apellido: 1 }).toArray();
    const ids = users.map(user => String(user._id));
    const [profiles, documents] = await Promise.all([
      EmployeeProfile.find({ usuarioId: { $in: ids } }),
      EmployeeDocument.find({ usuarioId: { $in: ids } }).select('-datos').sort({ createdAt: -1 }),
    ]);
    const profileByUser = new Map(profiles.map(profile => [String(profile.usuarioId), profilePayload(profile)]));
    const docsByUser = new Map();
    documents.forEach(document => {
      const key = String(document.usuarioId);
      if (!docsByUser.has(key)) docsByUser.set(key, []);
      docsByUser.get(key).push(document.toObject());
    });
    res.json({ empleados: users.map(user => ({
      usuario: publicUser(user),
      perfil: profileByUser.get(String(user._id)) || {},
      documentos: docsByUser.get(String(user._id)) || [],
    })) });
  } catch (error) {
    res.status(500).json({ error: 'No se pudieron cargar los expedientes.' });
  }
});

router.get('/catalogo/permisos', (req, res) => {
  res.json({ permisos: CRM_PERMISSIONS.map(([clave, nombre]) => ({ clave, nombre })) });
});

// Crea la identidad de CRM y el expediente en una misma operación lógica.
// Por seguridad la cuenta queda pendiente hasta que el administrador la active.
router.post('/', async (req, res) => {
  try {
    const { usuario = {}, perfil = {}, password, crearAcceso = false } = req.body || {};
    const nombre = String(usuario.nombre || '').trim();
    const correo = String(usuario.correo || '').trim().toLowerCase();
    const rol = ['admin', 'socio', 'user'].includes(usuario.rol) ? usuario.rol : 'user';
    if (!nombre || !correo) return res.status(400).json({ error: 'Nombre y correo son obligatorios.' });
    if (crearAcceso && String(password || '').length < 10) return res.status(400).json({ error: 'La contraseña temporal debe tener al menos 10 caracteres.' });
    const exists = await mongoose.connection.db.collection('users').findOne({ correo }, { projection: { _id: 1 } });
    if (exists) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

    const userId = new mongoose.Types.ObjectId().toString();
    const estadoCuenta = crearAcceso ? 'pendiente' : 'inactiva';
    const permissions = Array.isArray(usuario.permisosCrm)
      ? usuario.permisosCrm.filter(permission => VALID_PERMISSIONS.has(permission))
      : defaultPermissions(rol);
    const user = {
      _id: userId, nombre, apellido: String(usuario.apellido || '').trim(), correo,
      telefono: String(usuario.telefono || '').trim(), rol, estadoCuenta,
      password: crearAcceso ? passwordHash(password) : '', permisosCrm: permissions,
      sessionVersion: 0, accesoCrm: { estado: estadoCuenta, actualizadoEn: new Date(), actualizadoPor: String(req.user.id) },
      creadoEn: new Date(), creadoPor: String(req.user.id),
    };
    await mongoose.connection.db.collection('users').insertOne(user);
    const profile = await EmployeeProfile.create({ ...profile, usuarioId: userId });
    await audit(req, userId, 'empleado.creado', `Expediente creado para ${correo}`, { crearAcceso });
    res.status(201).json({ usuario: cleanEmployee(user), perfil: profilePayload(profile), mensaje: crearAcceso ? 'Expediente creado; activa la cuenta cuando el empleado deba ingresar.' : 'Expediente creado sin acceso al CRM.' });
  } catch (error) {
    console.error('[Expedientes] Error creando empleado:', error.message);
    res.status(500).json({ error: 'No se pudo crear el empleado.' });
  }
});

router.get('/:userId', async (req, res) => {
  try {
    // Leer al usuario primero. Un expediente o documento legado defectuoso no
    // debe impedir abrir y editar la ficha básica de un empleado existente.
    const user = await findCRMUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const employeeId = String(user._id);
    let profile = null;
    let documents = [];
    const warnings = [];
    try { profile = await EmployeeProfile.findOne({ usuarioId: employeeId }).lean(); }
    catch (error) { warnings.push('No se pudo cargar el perfil complementario.'); console.error('[Expedientes] Perfil:', error.message); }
    try { documents = await EmployeeDocument.find({ usuarioId: employeeId }).select('-datos').sort({ createdAt: -1 }).lean(); }
    catch (error) { warnings.push('No se pudieron cargar los documentos.'); console.error('[Expedientes] Documentos:', error.message); }
    // El perfil nuevo tiene prioridad; los campos heredados completan solo lo
    // que todavía no se haya capturado en employee_profiles.
    const perfil = { ...legacyProfileValues(user), ...(profile || {}) };
    res.json({
      usuario: publicUser(user),
      perfil,
      documentos,
      documentosLegacy: legacyDocuments(user),
      warnings,
    });
  } catch (error) {
    console.error('[Expedientes] Error cargando expediente:', req.params.userId, error.message);
    res.status(500).json({ error: 'No se pudo leer el usuario desde MongoDB.', detalle: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
});

router.put('/:userId', async (req, res) => {
  try {
    const { usuario = {}, perfil = {} } = req.body || {};
    const allowedUserFields = ['nombre', 'apellido', 'telefono', 'correo', 'rol', 'estadoCuenta', 'categoria', 'sueldoBase'];
    const allowedProfileFields = ['puesto', 'departamento', 'sucursal', 'tipoContrato', 'estadoLaboral', 'curp', 'rfc', 'nss', 'direccion', 'notas'];
    const userUpdate = {};
    const profileUpdate = {};

    allowedUserFields.forEach(field => { if (Object.prototype.hasOwnProperty.call(usuario, field)) userUpdate[field] = usuario[field]; });
    allowedProfileFields.forEach(field => { if (Object.prototype.hasOwnProperty.call(perfil, field)) profileUpdate[field] = perfil[field]; });
    ['fechaIngreso', 'fechaNacimiento'].forEach(field => {
      if (Object.prototype.hasOwnProperty.call(perfil, field)) profileUpdate[field] = dateOrUndefined(perfil[field]) || null;
    });
    ['contactoEmergencia', 'banco', 'acceso'].forEach(field => {
      if (perfil[field] && typeof perfil[field] === 'object') profileUpdate[field] = perfil[field];
    });

    const existingUser = await findCRMUser(req.params.userId, { _id: 1 });
    if (!existingUser) return res.status(404).json({ error: 'Empleado no encontrado.' });
    await mongoose.connection.db.collection('users').updateOne({ _id: existingUser._id }, { $set: userUpdate });
    const user = await mongoose.connection.db.collection('users').findOne({ _id: existingUser._id }, { projection: { password: 0, tokenPortal: 0 } });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const profile = await EmployeeProfile.findOneAndUpdate(
      { usuarioId: String(user._id) },
      { $set: profileUpdate, $setOnInsert: { usuarioId: String(user._id) } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    await audit(req, user._id, 'expediente.actualizado', 'Se actualizaron datos del perfil.');
    res.json({ usuario: publicUser(user), perfil: profilePayload(profile) });
  } catch (error) {
    res.status(400).json({ error: `No se pudo guardar el expediente: ${error.message}` });
  }
});

router.put('/:userId/permisos', async (req, res) => {
  try {
    const user = await findCRMUser(req.params.userId, { _id: 1, rol: 1 });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const permissions = Array.isArray(req.body?.permisos)
      ? [...new Set(req.body.permisos.filter(permission => VALID_PERMISSIONS.has(permission)))]
      : [];
    await mongoose.connection.db.collection('users').updateOne({ _id: user._id }, { $set: { permisosCrm: permissions, permisosActualizadosEn: new Date(), permisosActualizadosPor: String(req.user.id) } });
    await audit(req, user._id, 'cuenta.permisos_actualizados', `${permissions.length} permisos asignados.`, { permisos: permissions });
    res.json({ permisos: permissions });
  } catch (error) {
    console.error('[Expedientes] Error guardando permisos:', error.message);
    res.status(500).json({ error: 'No se pudieron guardar los permisos.' });
  }
});

router.patch('/:userId/cuenta/estado', async (req, res) => {
  try {
    const estado = String(req.body?.estado || '').toLowerCase();
    if (!VALID_ACCOUNT_STATES.has(estado)) return res.status(400).json({ error: 'Estado de cuenta no válido.' });
    const user = await findCRMUser(req.params.userId, { _id: 1, correo: 1, password: 1 });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    if (estado === 'activa' && !String(user.password || '').trim()) {
      return res.status(400).json({ error: 'Define una contraseña temporal antes de activar la cuenta.' });
    }
    const update = {
      estadoCuenta: estado,
      'accesoCrm.estado': estado,
      'accesoCrm.actualizadoEn': new Date(),
      'accesoCrm.actualizadoPor': String(req.user.id),
    };
    await mongoose.connection.db.collection('users').updateOne({ _id: user._id }, { $set: update, $inc: { sessionVersion: 1 } });
    await audit(req, user._id, `cuenta.${estado}`, `Acceso CRM marcado como ${estado}.`);
    res.json({ estado, mensaje: estado === 'activa' ? 'Cuenta activada.' : 'Cuenta suspendida/revocada; la próxima validación cerrará la sesión del empleado.' });
  } catch (error) {
    console.error('[Expedientes] Error cambiando acceso:', error.message);
    res.status(500).json({ error: 'No se pudo actualizar el acceso CRM.' });
  }
});

router.post('/:userId/cuenta/password', async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    if (password.length < 10) return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres.' });
    const user = await findCRMUser(req.params.userId, { _id: 1 });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    await mongoose.connection.db.collection('users').updateOne({ _id: user._id }, { $set: { password: passwordHash(password), passwordActualizadaEn: new Date() }, $inc: { sessionVersion: 1 } });
    await audit(req, user._id, 'cuenta.password_restablecida', 'Un administrador restableció la contraseña.');
    res.json({ success: true, mensaje: 'Contraseña actualizada.' });
  } catch (error) {
    res.status(500).json({ error: 'No se pudo restablecer la contraseña.' });
  }
});

router.get('/:userId/auditoria', async (req, res) => {
  try {
    const events = await EmployeeAudit.find({ empleadoId: String(req.params.userId) }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ eventos: events });
  } catch (error) {
    res.status(500).json({ error: 'No se pudo cargar la auditoría.' });
  }
});

router.post('/:userId/documentos', async (req, res) => {
  try {
    const { nombre, tipo, contentType, datos } = req.body || {};
    if (!nombre || !datos || typeof datos !== 'string') return res.status(400).json({ error: 'Nombre y contenido del documento son obligatorios.' });
    const data = datos.replace(/^data:[^;]+;base64,/, '');
    const size = Buffer.byteLength(data, 'base64');
    if (!Number.isFinite(size) || size > MAX_DOCUMENT_BYTES) return res.status(413).json({ error: 'Cada documento puede pesar hasta 8 MB.' });
    const user = await findCRMUser(req.params.userId, { _id: 1 });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const document = await EmployeeDocument.create({ usuarioId: String(user._id), nombre, tipo, contentType, tamanio: size, datos: data });
    await audit(req, user._id, 'documento.agregado', `${tipo || 'Documento'}: ${nombre}`);
    res.status(201).json(document.toObject({ transform: (_, value) => { delete value.datos; return value; } }));
  } catch (error) {
    res.status(400).json({ error: 'No se pudo subir el documento.' });
  }
});

router.get('/:userId/documentos/:documentId/archivo', async (req, res) => {
  try {
    const document = await EmployeeDocument.findOne({ _id: req.params.documentId, usuarioId: String(req.params.userId) }).select('+datos');
    if (!document) return res.status(404).json({ error: 'Documento no encontrado.' });
    res.type(document.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${String(document.nombre).replace(/[\r\n"]/g, '')}"`);
    res.send(Buffer.from(document.datos, 'base64'));
  } catch (error) {
    res.status(404).json({ error: 'Documento no encontrado.' });
  }
});

router.delete('/:userId/documentos/:documentId', async (req, res) => {
  try {
    const document = await EmployeeDocument.findOneAndDelete({ _id: req.params.documentId, usuarioId: String(req.params.userId) });
    if (!document) return res.status(404).json({ error: 'Documento no encontrado.' });
    await audit(req, req.params.userId, 'documento.eliminado', `Documento eliminado: ${document.nombre}`);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'No se pudo eliminar el documento.' });
  }
});

function hikvisionConfig() {
  const url = String(process.env.HIKVISION_ISAPI_URL || '').replace(/\/$/, '');
  const username = process.env.HIKVISION_USERNAME;
  const password = process.env.HIKVISION_PASSWORD;
  if (!url || !username || !password) return null;
  return { url, username, password, auth: String(process.env.HIKVISION_AUTH || 'digest').toLowerCase() };
}

function md5(value) { return crypto.createHash('md5').update(value).digest('hex'); }
function parseDigest(value) {
  const challenge = {};
  String(value || '').replace(/([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]*))/g, (_, key, quoted, plain) => {
    challenge[key.toLowerCase()] = quoted || plain || '';
    return _;
  });
  return challenge;
}

async function hikvisionPost(config, route, body) {
  const target = `${config.url}${route}`;
  const request = authorization => fetch(target, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  if (config.auth === 'basic') return request(`Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`);
  const first = await request();
  if (first.status !== 401) return first;
  const challenge = parseDigest(first.headers.get('www-authenticate'));
  if (!challenge.realm || !challenge.nonce) throw new Error('El controlador no devolvió un reto Digest válido.');
  const uri = new URL(target).pathname + new URL(target).search;
  const nc = '00000001';
  const cnonce = crypto.randomBytes(12).toString('hex');
  const qop = challenge.qop ? 'auth' : '';
  const ha1 = md5(`${config.username}:${challenge.realm}:${config.password}`);
  const ha2 = md5(`POST:${uri}`);
  const response = qop ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const fields = [`username="${config.username}"`, `realm="${challenge.realm}"`, `nonce="${challenge.nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return request(`Digest ${fields.join(', ')}`);
}

// Alta de persona y tarjeta en controladores Hikvision ISAPI. Las credenciales
// permanecen exclusivamente en variables de entorno del servidor.
router.post('/:userId/acceso/hikvision/sincronizar', async (req, res) => {
  const config = hikvisionConfig();
  if (!config) return res.status(503).json({ error: 'Hikvision no está configurado en el servidor. Define HIKVISION_ISAPI_URL, HIKVISION_USERNAME y HIKVISION_PASSWORD.' });
  try {
    const user = await findCRMUser(req.params.userId, { nombre: 1, apellido: 1 });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const profile = await EmployeeProfile.findOne({ usuarioId: String(user._id) });
    const access = { ...(profile?.acceso?.toObject?.() || profile?.acceso || {}), ...(req.body?.acceso || {}) };
    const employeeNo = String(access.employeeNo || user._id);
    const cardNo = String(access.tarjetaNumero || '').trim();
    if (!cardNo) return res.status(400).json({ error: 'Captura el número de tarjeta antes de sincronizar.' });
    const fullName = `${user.nombre || ''} ${user.apellido || ''}`.trim() || employeeNo;
    const valid = { enable: true, beginTime: '2020-01-01T00:00:00', endTime: '2099-12-31T23:59:59' };
    const personResponse = await hikvisionPost(config, '/ISAPI/AccessControl/UserInfo/Record?format=json', { UserInfo: { employeeNo, name: fullName, userType: 'normal', Valid: valid } });
    // Algunos firmwares devuelven conflicto si la persona ya existe. En ese
    // caso se intenta registrar/actualizar la tarjeta de todas formas.
    const cardResponse = await hikvisionPost(config, '/ISAPI/AccessControl/CardInfo/Record?format=json', { CardInfo: { employeeNo, cardNo, cardType: 'normalCard', Valid: valid } });
    const cardResult = await cardResponse.text();
    if (!cardResponse.ok) throw new Error(`El controlador rechazó la tarjeta (${cardResponse.status}): ${cardResult.slice(0, 220)}`);
    const saved = await EmployeeProfile.findOneAndUpdate({ usuarioId: String(user._id) }, { $set: {
      'acceso.employeeNo': employeeNo, 'acceso.tarjetaNumero': cardNo, 'acceso.estado': 'Activa en Hikvision', 'acceso.ultimaSincronizacion': new Date(), 'acceso.ultimoResultado': 'Tarjeta sincronizada',
    }, $setOnInsert: { usuarioId: String(user._id) } }, { new: true, upsert: true, setDefaultsOnInsert: true });
    res.json({ success: true, perfil: profilePayload(saved), personaRegistrada: personResponse.ok });
  } catch (error) {
    await EmployeeProfile.findOneAndUpdate({ usuarioId: String(req.params.userId) }, { $set: { 'acceso.estado': 'Error de sincronización', 'acceso.ultimoResultado': error.message, 'acceso.ultimaSincronizacion': new Date() } }).catch(() => {});
    res.status(502).json({ error: error.message || 'No fue posible comunicar con Hikvision.' });
  }
});

router.post('/:userId/acceso/hikvision/revocar', async (req, res) => {
  const config = hikvisionConfig();
  if (!config) return res.status(503).json({ error: 'Hikvision no está configurado en el servidor.' });
  try {
    const user = await findCRMUser(req.params.userId, { _id: 1 });
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const profile = await EmployeeProfile.findOne({ usuarioId: String(user._id) });
    const employeeNo = String(profile?.acceso?.employeeNo || user._id);
    const response = await hikvisionPost(config, '/ISAPI/AccessControl/CardInfo/Delete?format=json', { CardInfoDelCond: { EmployeeNoList: [{ employeeNo }] } });
    const body = await response.text();
    if (!response.ok) throw new Error(`El controlador rechazó la baja (${response.status}): ${body.slice(0, 220)}`);
    const saved = await EmployeeProfile.findOneAndUpdate({ usuarioId: String(user._id) }, { $set: { 'acceso.estado': 'Revocada en Hikvision', 'acceso.ultimaSincronizacion': new Date(), 'acceso.ultimoResultado': 'Tarjeta revocada' } }, { new: true });
    await audit(req, user._id, 'hikvision.revocado', 'Tarjeta revocada del control de acceso.');
    res.json({ success: true, perfil: profilePayload(saved) });
  } catch (error) {
    res.status(502).json({ error: error.message || 'No fue posible revocar el acceso en Hikvision.' });
  }
});

module.exports = router;
