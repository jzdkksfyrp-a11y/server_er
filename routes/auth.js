const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

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
const ROL_MAP = { admin: 'admin', socio: 'dom', user: 'empleado' };

router.get('/users', async (req, res) => {
  try {
    // Solo traer los usuarios que fueron creados desde este programa (que tienen el campo creadoPor)
    const users = await User.find({ creadoPor: { $exists: true } }, 'correo username nombre activo estadoCuenta').sort({ nombre: 1 });
    
    // Filtrar solo los activos
    const activeUsers = users.filter(u => typeof u.activo === 'boolean' ? u.activo : u.estadoCuenta === 'activa');
    
    const publicUsers = activeUsers.map(u => ({
      loginId: u.correo || u.username,
      nombre: u.nombre || u.correo || u.username
    }));
    
    res.json(publicUsers);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body; // el frontend sigue mandando "username"

    // Busca por correo O por username (compatible con ambos esquemas)
    const user = await User.findOne({
      $or: [{ correo: username }, { username }],
    });

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
      { id: user._id, username: user.correo || user.username, rol: rolNormalizado, nombre: user.nombre },
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
