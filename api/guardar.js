const admin = require('firebase-admin');
const crypto = require('crypto');
const { estaAutorizada } = require('./_sesion');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function normalizarNombre(valor) {
  return String(valor || '')
    .replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function validarFecha(fecha) {
  if (!fecha) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;

  const [ano, mes, dia] = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));

  return (
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia
  );
}

function datosPeriodo(clave) {
  const [ano, mes, tipo] = clave.split('_').map(Number);

  if (tipo === 1) {
    return {
      fin: `${ano}-${String(mes).padStart(2, '0')}-15`,
      siguiente: `${ano}_${mes}_2`,
      inicioSiguiente:
        `${ano}-${String(mes).padStart(2, '0')}-16`
    };
  }

  const ultimoDia = new Date(
    Date.UTC(ano, mes, 0)
  ).getUTCDate();
  const siguienteAno = mes === 12 ? ano + 1 : ano;
  const siguienteMes = mes === 12 ? 1 : mes + 1;

  return {
    fin:
      `${ano}-${String(mes).padStart(2, '0')}-` +
      `${String(ultimoDia).padStart(2, '0')}`,
    siguiente: `${siguienteAno}_${siguienteMes}_1`,
    inicioSiguiente:
      `${siguienteAno}-` +
      `${String(siguienteMes).padStart(2, '0')}-01`
  };
}

function claveNombre(huesped) {
  return (
    `${normalizarNombre(huesped.nombre)}|` +
    `${huesped.hostal || ''}`
  );
}

function idCopiaCierre(quincena, estanciaId) {
  return `cierre_${quincena}_${estanciaId}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 140);
}

module.exports = async function handler(req, res) {
  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Automation-Secret'
  );
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido'
    });
  }

  try {
    const secretoConfigurado =
      process.env.AUTOMATION_SECRET;
    if (!estaAutorizada(req, secretoConfigurado)) {
      return res.status(401).json({
        ok: false,
        error: 'No autorizado'
      });
    }

    const {
      huespedes,
      quincena,
      eliminarIds = [],
      permitirLimpiarSalidaIds = []
    } = req.body || {};
    const quincenaLimpia = String(quincena || '').trim();

    if (!/^\d{4}_(?:[1-9]|1[0-2])_[12]$/.test(quincenaLimpia)) {
      return res.status(400).json({
        ok: false,
        error: 'Quincena no válida'
      });
    }

    if (!Array.isArray(huespedes)) {
      return res.status(400).json({
        ok: false,
        error: 'La lista de huéspedes no es válida'
      });
    }

    if (
      !Array.isArray(eliminarIds) ||
      !Array.isArray(permitirLimpiarSalidaIds)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'La operación de guardado no es válida'
      });
    }

    const datosValidos = huespedes.map((h, orden) => {
      const id = String(h.id || '').trim();
      const nombre = String(h.nombre || '').trim();
      const hostal = String(h.hostal || '').trim();
      const fechaEntrada = String(h.fechaEntrada || '').trim();
      const fechaSalida = String(h.fechaSalida || '').trim();

      if (!id || id.includes('/') || id.length > 200) {
        throw new Error(
          'Uno de los huéspedes tiene un identificador no válido'
        );
      }

      if (!nombre) {
        throw new Error('Uno de los huéspedes no tiene nombre');
      }

      if (!hostal) {
        throw new Error(`Falta el hostal de ${nombre}`);
      }

      if (
        !validarFecha(fechaEntrada) ||
        !validarFecha(fechaSalida)
      ) {
        throw new Error(`Hay una fecha no válida en ${nombre}`);
      }

      return {
        id,
        nombre: nombre.slice(0, 200),
        nombre_normalizado: normalizarNombre(nombre),
        fnac: String(h.fnac || ''),
        hostal: hostal.slice(0, 100),
        fecha_entrada: fechaEntrada,
        fecha_salida: fechaSalida,
        cabeza: Boolean(h.cabeza),
        picnic: Boolean(h.picnic),
        min_dias: Math.max(0, Number(h.minDias) || 0),
        snack_dias: Math.max(0, Number(h.snackDias) || 0),
        importado: Boolean(h.importado),
        orden,
        tipo_manual: String(h.tipoManual || ''),
        sin_snack: Boolean(h.sinSnack),
        origen_cierre: String(h.origenCierre || ''),
        estancia_id: String(h.estanciaId || ''),
        quincena: quincenaLimpia
      };
    });

    const idsActuales = new Set(
      datosValidos.map((h) => h.id)
    );

    if (idsActuales.size !== datosValidos.length) {
      return res.status(400).json({
        ok: false,
        error: 'Hay identificadores de huéspedes duplicados'
      });
    }

    if (datosValidos.length + eliminarIds.length > 240) {
      return res.status(400).json({
        ok: false,
        error:
          'Demasiados registros para guardar de forma segura en una sola operación'
      });
    }

    const periodo = datosPeriodo(quincenaLimpia);
    const col = db.collection('huespedes');
    const cierreRef = db
      .collection('cierres_quincena')
      .doc(periodo.siguiente);
    const limpiarSalida = new Set(
      permitirLimpiarSalidaIds.map(String)
    );
    const idsAEliminar = new Set(eliminarIds.map(String));

    const resultado = await db.runTransaction(
      async (transaction) => {
        const [snap, siguienteSnap, cierreSnap] =
          await Promise.all([
            transaction.get(
              col.where('quincena', '==', quincenaLimpia)
            ),
            transaction.get(
              col.where('quincena', '==', periodo.siguiente)
            ),
            transaction.get(cierreRef)
          ]);

        const existentesPorId = new Map(
          snap.docs.map((doc) => [doc.id, doc.data()])
        );
        const existentePorEstancia = new Map();

        for (const doc of snap.docs) {
          const data = doc.data();
          const estancia = String(data.estancia_id || '').trim();

          if (estancia && !existentePorEstancia.has(estancia)) {
            existentePorEstancia.set(estancia, {
              id: doc.id,
              data,
              ref: doc.ref
            });
          }
        }

        const vistosEnPeticion = new Set();
        const datosFinales = [];
        let duplicadosEvitados = 0;

        for (const h of datosValidos) {
          const actual = { ...h };
          const anteriorMismoId = existentesPorId.get(actual.id);

          actual.estancia_id =
            actual.estancia_id ||
            anteriorMismoId?.estancia_id ||
            actual.id ||
            crypto.randomUUID();

          if (vistosEnPeticion.has(actual.estancia_id)) {
            duplicadosEvitados++;
            continue;
          }

          vistosEnPeticion.add(actual.estancia_id);

          const existenteMismaEstancia =
            existentePorEstancia.get(actual.estancia_id);

          if (
            existenteMismaEstancia &&
            existenteMismaEstancia.id !== actual.id
          ) {
            const previa = existenteMismaEstancia.data;
            const canon = {
              ...actual,
              id: existenteMismaEstancia.id,
              estancia_id: actual.estancia_id
            };

            if (previa.fecha_salida && !canon.fecha_salida) {
              canon.fecha_salida = previa.fecha_salida;
            }

            if (previa.fecha_entrada) {
              canon.fecha_entrada = previa.fecha_entrada;
            }

            datosFinales.push(canon);
            duplicadosEvitados++;
            continue;
          }

          if (
            anteriorMismoId?.fecha_salida &&
            !actual.fecha_salida &&
            !limpiarSalida.has(actual.id)
          ) {
            actual.fecha_salida = anteriorMismoId.fecha_salida;
          }

          datosFinales.push(actual);
        }

        let eliminados = 0;

        for (const doc of snap.docs) {
          if (idsAEliminar.has(doc.id)) {
            transaction.delete(doc.ref);
            eliminados++;
          }
        }

        for (const h of datosFinales) {
          transaction.set(col.doc(h.id), h);
        }

        let copiasRetiradas = 0;
        let copiasActualizadas = 0;
        let copiasCreadas = 0;
        const cierreYaEjecutado = Boolean(
          cierreSnap.exists &&
          cierreSnap.data().completado === true
        );

        if (cierreYaEjecutado) {
          const siguientes = siguienteSnap.docs.map((doc) => ({
            ref: doc.ref,
            id: doc.id,
            ...doc.data()
          }));
          const refsEliminadas = new Set();
          const porEstancia = new Map();
          const porNombre = new Map();

          for (const copia of siguientes) {
            const estancia = String(copia.estancia_id || '');

            if (estancia && !porEstancia.has(estancia)) {
              porEstancia.set(estancia, copia);
            }

            const nombre = claveNombre(copia);

            if (!porNombre.has(nombre)) {
              porNombre.set(nombre, copia);
            }
          }

          for (const h of datosFinales) {
            const estanciaId = String(h.estancia_id || h.id);
            const nombre = claveNombre(h);
            const copiasAutomaticas = siguientes.filter(
              (copia) =>
                copia.origen_cierre === quincenaLimpia &&
                (
                  String(copia.estancia_id || '') === estanciaId ||
                  claveNombre(copia) === nombre
                )
            );
            const continua =
              !h.fecha_salida || h.fecha_salida > periodo.fin;

            if (!continua) {
              for (const copia of copiasAutomaticas) {
                if (!refsEliminadas.has(copia.id)) {
                  transaction.delete(copia.ref);
                  refsEliminadas.add(copia.id);
                  copiasRetiradas++;
                }
              }
              continue;
            }

            const existente =
              porEstancia.get(estanciaId) ||
              porNombre.get(nombre);

            if (existente && !refsEliminadas.has(existente.id)) {
              const cambios = {
                estancia_id: estanciaId,
                actualizado_en:
                  admin.firestore.FieldValue.serverTimestamp()
              };

              if (h.fecha_salida && !existente.fecha_salida) {
                cambios.fecha_salida = h.fecha_salida;
              }

              transaction.set(
                existente.ref,
                cambios,
                { merge: true }
              );
              copiasActualizadas++;
              continue;
            }

            const copiaId = idCopiaCierre(
              periodo.siguiente,
              estanciaId
            );
            const ref = col.doc(copiaId);
            const copia = {
              id: copiaId,
              nombre: h.nombre,
              nombre_normalizado: normalizarNombre(h.nombre),
              estancia_id: estanciaId,
              fnac: h.fnac || '',
              hostal: h.hostal,
              fecha_entrada: periodo.inicioSiguiente,
              fecha_salida: h.fecha_salida || '',
              cabeza: Boolean(h.cabeza),
              picnic: false,
              min_dias: 0,
              snack_dias: 0,
              importado: Boolean(h.importado),
              orden: siguienteSnap.size + copiasCreadas,
              tipo_manual: h.tipo_manual || '',
              sin_snack: Boolean(h.sin_snack),
              quincena: periodo.siguiente,
              origen_cierre: quincenaLimpia,
              creado_en:
                admin.firestore.FieldValue.serverTimestamp(),
              actualizado_en:
                admin.firestore.FieldValue.serverTimestamp()
            };

            transaction.set(ref, copia, { merge: true });
            porEstancia.set(estanciaId, { ref, ...copia });
            porNombre.set(nombre, { ref, ...copia });
            copiasCreadas++;
          }
        }

        return {
          guardados: datosFinales.length,
          eliminados,
          duplicadosEvitados,
          copiasRetiradas,
          copiasActualizadas,
          copiasCreadas
        };
      }
    );

    return res.status(200).json({
      ok: true,
      guardados: resultado.guardados,
      eliminados: resultado.eliminados,
      duplicadosEvitados: resultado.duplicadosEvitados,
      copiasRetiradas: resultado.copiasRetiradas,
      copiasActualizadas: resultado.copiasActualizadas,
      copiasCreadas: resultado.copiasCreadas,
      borradoMasivoDeshabilitado: true
    });
  } catch (error) {
    console.error('Error al guardar huéspedes:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudieron guardar los huéspedes'
    });
  }
};
