const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { FILTRO_APP_IT, normalizarUsername } = require('../utils/usuariosAppIt');

const router = express.Router();

function verificarPasswordUniversal(password, storedPassword) {
  const stored = String(storedPassword || '');
  if (!stored || !password) return false;

  // 1. scrypt (empleados.js / server_2)
  if (stored.startsWith('scrypt$')) {
    const [, salt, expected] = stored.split('$');
    if (!salt || !expected) return false;
    try {
      const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
      const a = Buffer.from(derived, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) {
      return false;
    }
  }

  // 2. bcrypt ($2a$, $2b$, $2y$)
  if (/^\$2[aby]\$\d+\$/.test(stored)) {
    try {
      return bcrypt.compareSync(String(password), stored);
    } catch (_) {
      return false;
    }
  }

  // 3. Texto plano histórico
  return stored === String(password);
}

// Mapa de roles de naisata_db → roles internos de app-it
// (incluye los roles propios de app-it: antes 'dom' caía en 'empleado' al iniciar sesión)
const ROL_MAP = { admin: 'admin', socio: 'dom', user: 'empleado', dom: 'dom', empleado: 'empleado' };

router.get('/users', async (req, res) => {
  try {
    // Solo usuarios creados desde app-it (origen 'app-it'); los del CRM no se mezclan
    const users = await User.find(FILTRO_APP_IT, 'correo username nombre activo estadoCuenta').sort({ nombre: 1 });
    
    // Filtrar solo los activos
    const activeUsers = users.filter(u => typeof u.activo === 'boolean' ? u.activo : u.estadoCuenta === 'activa');
    
    const publicUsers = activeUsers.map(u => ({
      loginId: u.username || u.correo,
      nombre: u.nombre || u.username || u.correo
    }));
    
    res.json(publicUsers);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {}; // el frontend sigue mandando "username"

    // Solo strings: evita inyección de operadores Mongo (ej. {"$ne": null}) en el login
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const loginId = username.trim();
    const loginKey = normalizarUsername(loginId);

    // 1) Primero el usuario propio de app-it (único por username, sin importar mayúsculas)
    let user = await User.findOne({
      $and: [FILTRO_APP_IT, { $or: [{ usernameKey: loginKey }, { username: loginId }] }],
    });

    // 2) Compatibilidad: cuentas de naisata_db que ya entraban por correo/username
    if (!user) {
      user = await User.findOne({ $or: [{ correo: loginId }, { username: loginId }] });
    }

    if (!user) {
      console.log(`[LOGIN FALLIDO] Usuario no encontrado: ${username}`);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    // Verificar que la cuenta este activa (soporta activo:boolean y estadoCuenta:string)
    const estaActivo = typeof user.activo === 'boolean'
      ? user.activo
      : user.estadoCuenta === 'activa';
    if (!estaActivo) {
      console.log(`[LOGIN FALLIDO] Cuenta inactiva para: ${username}`);
      return res.status(401).json({ error: 'Cuenta inactiva' });
    }

    const valido = verificarPasswordUniversal(password, user.password);
    if (!valido) {
      console.log(`[LOGIN FALLIDO] Contraseña incorrecta para: ${username}`);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    console.log(`[LOGIN EXITOSO] ${username} (${user.rol})`);

    // Normalizar rol al formato interno de app-it (por defecto todos son empleados si no son admin/dom)
    const rolNormalizado = ROL_MAP[user.rol] || 'empleado';

    const token = jwt.sign(
      { id: user._id, username: user.correo || user.username, rol: rolNormalizado, nombre: user.nombre, sessionVersion: Number(user.sessionVersion || 0) },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, usuario: { id: user._id, nombre: user.nombre, rol: rolNormalizado } });
  } catch (err) {
    console.error('Error login:', err);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

module.exports = router;
