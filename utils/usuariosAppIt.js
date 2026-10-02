const mongoose = require('mongoose');
const User = require('../models/User');

// La colección "users" es COMPARTIDA con otros sistemas (CRM de empleados / naisata_db).
// Para que los usuarios de app-it no se mezclen con los demás, cada usuario creado
// desde app-it queda marcado con origen: 'app-it' y con una llave de login normalizada
// (usernameKey) sobre la que hay un índice único.
const ORIGEN = 'app-it';
const ROLES = ['empleado', 'dom', 'admin'];
const PASSWORD_MIN = 8;
const USERNAME_RE = /^[a-z0-9][a-z0-9._@-]{2,49}$/;

// Usuarios creados por app-it ANTES de existir el campo "origen":
// tienen username, creadoPor como ObjectId (el CRM lo guarda como String) y no tienen correo.
const FILTRO_LEGACY = {
  origen: { $exists: false },
  username: { $type: 'string', $ne: '' },
  creadoPor: { $type: 'objectId' },
  correo: { $exists: false },
};

// Filtro único para "usuarios que pertenecen a app-it"
const FILTRO_APP_IT = { $or: [{ origen: ORIGEN }, FILTRO_LEGACY] };

function normalizarUsername(valor) {
  return String(valor == null ? '' : valor).trim().toLowerCase();
}

// Devuelve un mensaje de error (string) o null si todo está bien.
function validarNuevoUsuario({ username, password, nombre, rol }) {
  if (!nombre || nombre.length > 100) return 'El nombre es obligatorio (máximo 100 caracteres).';
  if (!USERNAME_RE.test(username)) {
    return 'El usuario debe tener de 3 a 50 caracteres: letras, números, punto, guion, guion bajo o @, sin espacios.';
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
  }
  if (!ROLES.includes(rol)) return 'Rol invalido';
  return null;
}

// ¿Ya existe ALGUIEN en toda la colección con esa identidad de login?
// Revisa correo, username y usernameKey sin distinguir mayúsculas, para no chocar
// tampoco con cuentas del CRM.
async function existeIdentidad(key) {
  return User.findOne({ $or: [{ correo: key }, { username: key }, { usernameKey: key }] })
    .collation({ locale: 'es', strength: 2 })
    .select('_id')
    .lean();
}

// Marca los usuarios antiguos de app-it con origen + usernameKey (idempotente).
// Si hubiera usernames repetidos entre los antiguos, solo el primero recibe la llave
// única; los demás se marcan como app-it, se avisa en logs y se resuelven a mano.
async function migrarUsuariosLegacy() {
  const ocupadas = new Set(
    (await User.find({ origen: ORIGEN, usernameKey: { $type: 'string' } }).select('usernameKey').lean())
      .map((u) => u.usernameKey)
  );
  const legacy = await User.find(FILTRO_LEGACY).select('_id username').sort({ createdAt: 1, _id: 1 }).lean();
  if (!legacy.length) return;

  const ops = [];
  for (const u of legacy) {
    const key = normalizarUsername(u.username);
    const set = { origen: ORIGEN };
    if (key && !ocupadas.has(key)) {
      set.usernameKey = key;
      ocupadas.add(key);
    } else {
      console.error(`[USUARIOS] Username repetido entre usuarios de app-it, revisar manualmente: "${u.username}" (${u._id})`);
    }
    ops.push({ updateOne: { filter: { _id: u._id }, update: { $set: set } } });
  }
  await User.bulkWrite(ops, { timestamps: false });
  console.log(`[USUARIOS] ${ops.length} usuario(s) antiguos marcados como app-it`);
}

// Se llama una vez al conectar a MongoDB. Nunca debe tumbar el servidor.
async function prepararUsuariosAppIt() {
  try {
    await migrarUsuariosLegacy();
    await User.createIndexes(); // solo crea los índices del modelo; no borra los de otros sistemas
    console.log('[USUARIOS] Índice único de usuarios de app-it listo');
  } catch (err) {
    console.error('[USUARIOS] No se pudo preparar el índice único de usuarios:', err.message);
  }
}

module.exports = {
  ORIGEN, ROLES, PASSWORD_MIN, FILTRO_APP_IT, FILTRO_LEGACY,
  normalizarUsername, validarNuevoUsuario, existeIdentidad, prepararUsuariosAppIt,
};
