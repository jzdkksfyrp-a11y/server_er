// Forzar Google DNS para resolver correctamente el SRV de MongoDB Atlas
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// --- WATCHDOG: Captura errores fatales y los guarda en crash_watchdog.log ---
// Portado del server.js original para diagnóstico remoto en Render
process.on('uncaughtException', (err) => {
  const time = new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
  const msg = `[${time}] [ERROR FATAL] Excepción no capturada: ${err.stack || err}\n`;
  try { fs.appendFileSync('crash_watchdog.log', msg); } catch (_) {}
  console.error(msg);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  const time = new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
  const msg = `[${time}] [ERROR FATAL] Promesa rechazada: ${(reason && reason.stack) || reason}\n`;
  try { fs.appendFileSync('crash_watchdog.log', msg); } catch (_) {}
  console.error(msg);
});
// ---------------------------------------------------------------------------

// --- Interceptor de logs en memoria (últimas 150 líneas) ---
// Permite ver logs de producción desde /api/it/logs sin abrir el dashboard de Render
const MAX_LOG_LINES = 150;
const serverLogs = [];
const _origLog = console.log;
const _origErr = console.error;

function _addLog(level, ...args) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  serverLogs.push(`[${ts}] [${level}] ${msg}`);
  if (serverLogs.length > MAX_LOG_LINES) serverLogs.shift();
}
console.log = (...args) => { _addLog('INFO', ...args); _origLog.apply(console, args); };
console.error = (...args) => { _addLog('ERROR', ...args); _origErr.apply(console, args); };
// -----------------------------------------------------------

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const taskRoutes = require('./routes/tasks');
const inventoryRoutes = require('./routes/inventory');
const gpsRoutes = require('./routes/gps');
const employeeRoutes = require('./routes/employees');

const app = express();
const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('io', io);

io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);
});

// CORS: acepta peticiones desde file:// (origen "null") y desde localhost
const corsOptions = {
  origin: (origin, callback) => {
    const allowed = !origin
      || origin === 'null'
      || /^http:\/\/localhost/.test(origin)
      || /\.github\.io$/.test(origin)
      || /\.onrender\.com$/.test(origin);
    if (allowed) callback(null, true);
    else callback(new Error(`Origen no permitido: ${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '15mb' }));

// Servir el frontend estático
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// FIX A: Opciones robustas de conexión a MongoDB Atlas
// - family:4  → fuerza IPv4, evita ECONNREFUSED intermitente en Render/Node nuevo
// - timeouts  → evita que el proceso quede colgado esperando al servidor de Mongo
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  heartbeatFrequencyMS:     10000,
  socketTimeoutMS:          45000,
  family: 4,
})
  .then(() => console.log('Conectado a MongoDB Atlas'))
  .catch((err) => console.error('Error al conectar a MongoDB:', err.message));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/tasks', taskRoutes);
app.use('/inventory', inventoryRoutes);
app.use('/push', require('./routes/push').router);
app.use('/api/empleados', employeeRoutes);
app.use('/', gpsRoutes);

// Verificación de que el API está activo
app.get('/status', (req, res) =>
  res.json({ status: 'server_a activo', puerto: process.env.PORT || 3009, uptime: process.uptime() })
);

// FIX A: Endpoint de diagnóstico de logs (portado del server.js original)
// Acceder en: https://server-er.onrender.com/api/it/logs
app.get('/api/it/logs', (req, res) => {
  let crashLogs = [];
  try {
    if (fs.existsSync('crash_watchdog.log')) {
      crashLogs = fs.readFileSync('crash_watchdog.log', 'utf8').split('\n').filter(Boolean);
    }
  } catch (_) {}
  res.json([...crashLogs, ...serverLogs]);
});

const PORT = process.env.PORT || 3009;
server.listen(PORT, '0.0.0.0', () => console.log(`server_a escuchando en el puerto ${PORT}`));

