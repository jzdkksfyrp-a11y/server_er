// node test/optimizer.test.js  (sin base de datos)
const assert = require('assert');
const { optimizarCortes } = require('../utils/cableOptimizer');
const T = (nombre, m, cable = 'utp_cat6', extra = {}) => ({ nombre, metrosEstimados: m, cableRequerido: cable, cortado: false, ...extra });
const B = (id, nombre, m, categoria = 'utp_cat6', extra = {}) => ({ _id: id, nombre, categoria, metrosIniciales: m, ...extra });
let n = 0; const t = (d, f) => { f(); n++; console.log('✅ ' + d); };

t('sin bobinas: pendiente_bobina (no "Sin cable suficiente")', () => {
  const r = optimizarCortes([], [T('a', 50), T('b', 30)]);
  assert(r.tiradas.every(x => x.estadoAsignacion === 'pendiente_bobina' && x.bobinaAsignada === null));
  assert.strictEqual(r.stats.sinBobinas, true); assert.strictEqual(r.stats.esSuficiente, false);
});
t('una bobina que alcanza: todo asignado con bobinaId', () => {
  const r = optimizarCortes([B('b1', 'Bobina 1', 305)], [T('a', 100), T('b', 120)]);
  assert(r.tiradas.every(x => x.estadoAsignacion === 'asignada' && x.bobinaId === 'b1'));
  assert.strictEqual(r.stats.esSuficiente, true); assert.strictEqual(r.stats.totalSobrante, 85);
});
t('no alcanza: sin_cable + faltantes por tipo', () => {
  const r = optimizarCortes([B('b1', 'B1', 100)], [T('a', 80), T('b', 60)]);
  assert.strictEqual(r.stats.metrosFaltantes, 60); assert.strictEqual(r.stats.faltantesPorTipo.utp_cat6, 60);
  assert.strictEqual(r.tiradas.find(x => x.nombre === 'b').bobinaAsignada, 'Sin cable suficiente');
});
t('segunda bobina acomoda las que faltaban', () => {
  const r = optimizarCortes([B('b1', 'B1', 100), B('b2', 'B2', 100)], [T('a', 80), T('b', 60)]);
  assert.strictEqual(r.stats.esSuficiente, true);
});
t('cada tirada solo usa bobina de su tipo', () => {
  const r = optimizarCortes([B('b1', 'U', 500), B('b2', 'F', 500, 'fibra_monomodo')], [T('a', 100, 'fibra_monomodo'), T('b', 100)]);
  assert.strictEqual(r.tiradas.find(x => x.nombre === 'a').bobinaId, 'b2'); assert.strictEqual(r.tiradas.find(x => x.nombre === 'b').bobinaId, 'b1');
});
t('nombres repetidos no mezclan descuentos (se usa bobinaId)', () => {
  const cortada = T('c', 90, 'utp_cat6', { cortado: true, metrosReales: 90, bobinaAsignada: 'Bobina 1', bobinaId: 'b2' });
  const r = optimizarCortes([B('b1', 'Bobina 1', 100), B('b2', 'Bobina 1', 100)], [cortada, T('p', 80)]);
  assert.strictEqual(r.tiradas.find(x => x.nombre === 'p').bobinaId, 'b1');   // b2 ya gastó 90
});
t('tirada cortada no se mueve al recalcular', () => {
  const cortada = T('c', 50, 'utp_cat6', { cortado: true, metrosReales: 50, bobinaAsignada: 'B1', bobinaId: 'b1', estadoAsignacion: 'asignada' });
  const r = optimizarCortes([B('b1', 'B1', 100), B('b2', 'B2', 100)], [cortada, T('p', 40)]);
  assert.strictEqual(r.tiradas.find(x => x.nombre === 'c').bobinaId, 'b1');
});
t('base = metrosAlAsignar cuando existe (bobina de inventario usada)', () => {
  const r = optimizarCortes([B('b1', 'B1', 1000, 'utp_cat6', { metrosAlAsignar: 100 })], [T('a', 150)]);
  assert.strictEqual(r.stats.metrosFaltantes, 150);
});
t('datos antiguos sin bobinaId: respaldo por nombre', () => {
  const cortada = T('c', 90, 'utp_cat6', { cortado: true, metrosReales: 90, bobinaAsignada: 'B1' });
  const r = optimizarCortes([B('b1', 'B1', 100)], [cortada, T('p', 50)]);
  assert.strictEqual(r.stats.metrosFaltantes, 50);
});
t('ids sin poblar (ObjectId) se ignoran sin romper', () => {
  const r = optimizarCortes(['65a1b2c3d4e5f6a7b8c9d0e1'], [T('a', 10)]);
  assert.strictEqual(r.tiradas[0].estadoAsignacion, 'pendiente_bobina');
});
console.log(`\nTodo bien (${n})`);
