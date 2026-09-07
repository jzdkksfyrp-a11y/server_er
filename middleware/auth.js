const jwt = require('jsonwebtoken');

// Valida el JWT que se genera al hacer login (lo usa el frontend)
function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No tienes permiso para esta accion' });
    }
    next();
  };
}

// Valida el token unico fijo que usara el sistema externo (a.naisata.com)
function verifyApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'API key invalida' });
  }
  req.user = { rol: 'admin', esIntegracionExterna: true };
  next();
}

// Permite entrar con JWT de un usuario admin o dom logueado en el frontend,
// O con el token unico de integracion usado por a.naisata.com
function adminOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return verifyToken(req, res, () => requireRole('admin', 'dom')(req, res, next));
  }
  return verifyApiKey(req, res, next);
}

module.exports = { verifyToken, requireRole, verifyApiKey, adminOrApiKey };
