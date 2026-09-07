/**
 * Motor de optimización de cortes de cable.
 * Algoritmo: Best Fit Decreasing (BFD).
 * Compatible con Frontend y Backend.
 */

function optimizarCortes(bobinas, tiradas) {
  if (!bobinas || !tiradas) return { bobinas: [], tiradas: [], stats: {} };

  // Copias limpias
  const bobinasLocales = bobinas.map(b => ({
    nombre: b.nombre,
    metrosIniciales: b.metrosIniciales,
    metrosRestantes: b.metrosIniciales
  }));

  const tiradasLocales = tiradas.map(t => ({
    ...t.toObject ? t.toObject() : t,
    // NO hacemos reset aquí en el backend, porque queremos conservar las bobinasAsignadas de las tiradas ya cortadas
  }));

  // Separar cortadas de pendientes
  const cortadas = tiradasLocales.filter(t => t.cortado);
  const pendientes = tiradasLocales.filter(t => !t.cortado);

  // Descontar ya cortadas (Para uso futuro en el backend cuando se añade una nueva tirada)
  cortadas.forEach(t => {
    if (t.bobinaAsignada) {
      const b = bobinasLocales.find(x => x.nombre === t.bobinaAsignada);
      if (b) {
        const gastado = t.metrosReales > 0 ? t.metrosReales : t.metrosEstimados;
        b.metrosRestantes -= gastado;
      }
    }
  });

  // Ordenar pendientes de mayor a menor longitud
  pendientes.sort((a, b) => b.metrosEstimados - a.metrosEstimados);

  let metrosFaltantes = 0;
  const tiradasSinCable = [];

  pendientes.forEach(tirada => {
    let mejorBobina = null;
    let menorSobra = Infinity;

    // Buscar el mejor ajuste (Best Fit)
    bobinasLocales.forEach(bobina => {
      if (bobina.metrosRestantes >= tirada.metrosEstimados) {
        const sobra = bobina.metrosRestantes - tirada.metrosEstimados;
        if (sobra < menorSobra) {
          menorSobra = sobra;
          mejorBobina = bobina;
        }
      }
    });

    if (mejorBobina) {
      tirada.bobinaAsignada = mejorBobina.nombre;
      mejorBobina.metrosRestantes -= tirada.metrosEstimados;
    } else {
      tirada.bobinaAsignada = "Sin cable suficiente";
      metrosFaltantes += tirada.metrosEstimados;
      tiradasSinCable.push(tirada);
    }
  });

  // Calcular métricas
  const bobinasSinUsar = bobinasLocales.filter(b => b.metrosRestantes === b.metrosIniciales);
  const totalSobrante = bobinasLocales.reduce((acc, b) => acc + (b.metrosRestantes === b.metrosIniciales ? 0 : b.metrosRestantes), 0);
  
  const stats = {
    metrosFaltantes,
    tiradasSinCable,
    bobinasSinUsar,
    totalSobrante, // sobrante total solo de las bobinas que SÍ se abrieron
    esSuficiente: metrosFaltantes === 0
  };

  return { 
    bobinas: bobinasLocales, 
    tiradas: [...cortadas, ...pendientes],
    stats
  };
}

// Exportar en Backend (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { optimizarCortes };
}
