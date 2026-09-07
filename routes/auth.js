const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

// Mapa de roles de naisata_db → roles internos de app-it
const ROL_MAP = { admin: 'admin', socio: 'dom', user: 'empleado' };

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

    const valido = await bcrypt.compare(password, user.password);
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
