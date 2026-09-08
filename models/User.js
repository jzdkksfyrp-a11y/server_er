const mongoose = require('mongoose');

// Esquema adaptado al modelo real de naisata_db.
// naisata_db usa:  email (en lugar de username)
//                  rol: 'admin' | 'socio' | 'user'
//                  estadoCuenta: 'activa' | 'inactiva' (en lugar de activo boolean)
const userSchema = new mongoose.Schema(
  {
    correo:       { type: String, trim: true },      // identificador principal de login en naisata_db
    username:     { type: String, trim: true },      // alias
    password:     { type: String },                  // hash bcrypt
    nombre:       { type: String },
    rol:          { type: String },                  // 'admin' | 'socio' | 'user'
    estadoCuenta: { type: String, default: 'activa' }, // 'activa' | 'inactiva'
    activo:       { type: Boolean },                 // campo legacy
    creadoPor:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { strict: false, timestamps: true }
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
