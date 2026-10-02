const mongoose = require('mongoose');

// Esquema adaptado al modelo real de naisata_db.
// naisata_db usa:  email (en lugar de username)
//                  rol: 'admin' | 'socio' | 'user'
//                  estadoCuenta: 'activa' | 'inactiva' (en lugar de activo boolean)
const userSchema = new mongoose.Schema(
  {
    correo:       { type: String, trim: true },      // identificador principal de login en naisata_db
    username:     { type: String, trim: true },      // alias (login de los usuarios creados desde app-it)
    usernameKey:  { type: String },                  // username en minúsculas; único entre usuarios de app-it
    origen:       { type: String },                  // 'app-it' = usuario creado desde esta app (no mezclar con CRM/naisata)
    password:     { type: String },                  // hash bcrypt
    nombre:       { type: String },
    rol:          { type: String },                  // 'admin' | 'socio' | 'user'
    estadoCuenta: { type: String, default: 'activa' }, // 'activa' | 'inactiva'
    activo:       { type: Boolean },                 // campo legacy
    creadoPor:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { strict: false, timestamps: true }
);

// Un username no puede repetirse entre usuarios de app-it (sin distinguir mayúsculas).
// Índice parcial: solo aplica a los usuarios marcados origen:'app-it', así no afecta a
// los demás usuarios de la colección compartida.
userSchema.index(
  { usernameKey: 1 },
  {
    unique: true,
    name: 'uniq_appit_usernameKey',
    partialFilterExpression: { origen: 'app-it', usernameKey: { $type: 'string' } },
  }
);

// Propiedad virtual: devuelve el identificador de login unificado
userSchema.virtual('loginId').get(function () {
  return this.correo || this.username;
});

// Propiedad virtual: normaliza el rol al formato interno de app-it
// naisata_db: admin->admin, socio->dom, user->empleado
userSchema.virtual('rolNormalizado').get(function () {
  const mapa = { admin: 'admin', socio: 'dom', user: 'empleado' };
  return mapa[this.rol] || this.rol;
});

// Propiedad virtual: unifica activo/estadoCuenta en un booleano
userSchema.virtual('estaActivo').get(function () {
  if (typeof this.activo === 'boolean') return this.activo;
  return this.estadoCuenta === 'activa';
});

module.exports = mongoose.model('User', userSchema);
