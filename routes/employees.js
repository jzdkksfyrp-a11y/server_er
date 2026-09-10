const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const EmployeeProfile = require('../models/EmployeeProfile');
const EmployeeDocument = require('../models/EmployeeDocument');
const { verifyToken, requireRole, verifyApiKey } = require('../middleware/auth');

const router = express.Router();
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

// server_2 define `_id` de users como String, mientras que otras versiones de
// la app lo crean como ObjectId. Consultamos la colección nativa para no
// convertir el ID recibido en la sesión ni perder compatibilidad entre ambos.
function userIdSelector(userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  if (!mongoose.isValidObjectId(id)) return id;
  return { $in: [id, new mongoose.Types.ObjectId(id)] };
}

async function findCRMUser(userId, projection = {}) {
  const selector = userIdSelector(userId);
  if (!selector) return null;
  return mongoose.connection.db.collection('users').findOne({ _id: selector }, { projection });
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

router.get('/:userId', async (req, res) => {
  try {
    const [user, profile, documents] = await Promise.all([
      findCRMUser(req.params.userId, { password: 0, tokenPortal: 0 }),
      EmployeeProfile.findOne({ usuarioId: String(req.params.userId) }),
      EmployeeDocument.find({ usuarioId: String(req.params.userId) }).select('-datos').sort({ createdAt: -1 }),
    ]);
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado.' });
    res.json({ usuario: publicUser(user), perfil: profilePayload(profile), documentos });
  } catch (error) {
    res.status(400).json({ error: 'Identificador de empleado no válido.' });
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
    res.json({ usuario: publicUser(user), perfil: profilePayload(profile) });
  } catch (error) {
    res.status(400).json({ error: `No se pudo guardar el expediente: ${error.message}` });
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

module.exports = router;
