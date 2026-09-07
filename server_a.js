// Forzar Google DNS para resolver correctamente el SRV de MongoDB Atlas
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const taskRoutes = require('./routes/tasks');
const inventoryRoutes = require('./routes/inventory');

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
// Esto permite abrir los HTML directamente sin un servidor HTTP extra.
const corsOptions = {
  origin: (origin, callback) => {
    // origin es undefined en Postman/curl, "null" en file:// y *.github.io en prod
    if (!origin || origin === 'null' || /^http:\/\/localhost/.test(origin) || /\.github\.io$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origen no permitido: ${origin}`));
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '15mb' })); // suficiente para fotos en base64

// Servir el frontend estatico desde el mismo servidor
// Acceder en: http://localhost:3009
app.use(express.static(path.join(__dirname, '..', 'frontend')));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Conectado a MongoDB Atlas'))
  .catch((err) => console.error('Error al conectar a MongoDB:', err.message));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/tasks', taskRoutes);
app.use('/inventory', inventoryRoutes);

// La ruta raiz ya la maneja express.static (index.html)
// Esta ruta es solo para verificar que el API esta activo
app.get('/status', (req, res) => res.json({ status: 'server_a activo', puerto: process.env.PORT || 3009 }));

const PORT = process.env.PORT || 3009;
server.listen(PORT, () => console.log(`server_a escuchando en el puerto ${PORT}`));
