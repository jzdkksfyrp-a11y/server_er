/**
 * Motor de optimización de cortes de cable.
 * Algoritmo: Best Fit Decreasing (BFD).
 * Compatible con Frontend y Backend (misma copia en js/cableOptimizer.js).
 *
 * Las bobinas se identifican por bobinaId (el nombre solo se usa como respaldo con datos antiguos).
 * La base de metros es metrosAlAsignar cuando existe, y metrosIniciales si no. El servidor ya descuenta
 * de la bobina cada corte, así que NO se usa metrosRestantes (se descontaría dos veces).
 *
 * Estado de asignación de cada tirada pendiente:
 *   - 'asignada'          -> bobinaAsignada (nombre) + bobinaId
 *   - 'pendiente_bobina'  -> la tarea todavía no tiene NINGUNA bobina (bobinaAsignada = null)
 *   - 'sin_cable'         -> hay bobinas pero no alcanzan: bobinaAsignada = "Sin cable suficiente"
 */
const SIN_CABLE = 'Sin cable suficiente';

function optimizarCortes(bobinas, tiradas) {
  if (!bobinas || !tiradas) return { bobinas: [], tiradas: [], stats: {} };

  // Copias limpias (solo bobinas "reales": ignora ids sin poblar)
  const bobinasLocales = bobinas.filter(b => b && b.nombre).map(b => {
    const base = typeof b.metrosAlAsignar === 'number' ? b.metrosAlAsignar : b.metrosIniciales;
    return {
      nombre: b.nombre,
      metrosIniciales: base,
      metrosRestantes: base,
      categoria: b.categoria,
      bobinaId: String(b.bobinaId || b._id || '')
    };
  });

  const tiradasLocales = tiradas.map(t => ({ ...(t.toObject ? t.toObject() : t) }));

  // Separar cortadas de pendientes
  const cortadas = tiradasLocales.filter(t => t.cortado);
  const pendientes = tiradasLocales.filter(t => !t.cortado);

  // Descontar las ya cortadas: por bobinaId y, si no lo tienen (datos antiguos), por nombre
  cortadas.forEach(t => {
    let b = null;
    if (t.bobinaId) b = bobinasLocales.find(x => x.bobinaId === String(t.bobinaId));
    if (!b && t.bobinaAsignada) b = bobinasLocales.find(x => x.nombre === t.bobinaAsignada);
    if (b) b.metrosRestantes -= (t.metrosReales > 0 ? t.metrosReales : t.metrosEstimados);
  });

  // Ordenar pendientes de mayor a menor longitud
  pendientes.sort((a, b) => b.metrosEstimados - a.metrosEstimados);

  const sinBobinas = bobinasLocales.length === 0;
  let metrosFaltantes = 0;
  const faltantesPorTipo = {};
  const tiradasSinCable = [];
  const tiradasPendientesBobina = [];

  pendientes.forEach(tirada => {
    if (sinBobinas) {
      tirada.bobinaAsignada = null;
      tirada.bobinaId = null;
      tirada.estadoAsignacion = 'pendiente_bobina';
      tiradasPendientesBobina.push(tirada);
      return;
    }

    let mejorBobina = null;
    let menorSobra = Infinity;
    bobinasLocales.forEach(bobina => {
      if (bobina.categoria === tirada.cableRequerido && bobina.metrosRestantes >= tirada.metrosEstimados) {
        const sobra = bobina.metrosRestantes - tirada.metrosEstimados;
        if (sobra < menorSobra) { menorSobra = sobra; mejorBobina = bobina; }
      }
    });

    if (mejorBobina) {
      tirada.bobinaAsignada = mejorBobina.nombre;
      tirada.bobinaId = mejorBobina.bobinaId || null;
      tirada.estadoAsignacion = 'asignada';
      mejorBobina.metrosRestantes -= tirada.metrosEstimados;
    } else {
      tirada.bobinaAsignada = SIN_CABLE;
      tirada.bobinaId = null;
      tirada.estadoAsignacion = 'sin_cable';
      metrosFaltantes += tirada.metrosEstimados;
      faltantesPorTipo[tirada.cableRequerido] = (faltantesPorTipo[tirada.cableRequerido] || 0) + tirada.metrosEstimados;
      tiradasSinCable.push(tirada);
    }
  });

  // Métricas
  const bobinasSinUsar = bobinasLocales.filter(b => b.metrosRestantes === b.metrosIniciales);
  const totalSobrante = bobinasLocales.reduce((acc, b) => acc + (b.metrosRestantes === b.metrosIniciales ? 0 : b.metrosRestantes), 0);

  const stats = {
    metrosFaltantes,
    faltantesPorTipo,
    tiradasSinCable,
    tiradasPendientesBobina,
    sinBobinas,
    bobinasSinUsar,
    totalSobrante, // sobrante total solo de las bobinas que SÍ se abrieron
    esSuficiente: metrosFaltantes === 0 && tiradasPendientesBobina.length === 0
  };

  return { bobinas: bobinasLocales, tiradas: [...cortadas, ...pendientes], stats };
}

// Exportar en Backend (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { optimizarCortes };
}
