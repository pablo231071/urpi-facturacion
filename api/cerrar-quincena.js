const admin = require('firebase-admin');

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

function fechaCanarias() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Atlantic/Canary',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const obtener = (tipo) =>
    partes.find((parte) => parte.type === tipo).value;

  return (
    `${obtener('year')}-${obtener('month')}-` +
    `${obtener('day')}`
  );
}

function validarFecha(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;

  const [ano, mes, dia] = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));

  return (
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia
  );
}

function datosCierre(fecha) {
  const [ano, mes, dia] = fecha.split('-').map(Number);

  // Permitir reconciliar una quincena cualquier día. Esto hace posible
  // reintentar un cierre fallido después del día 1 o 16 sin cambiar de
  // periodo ni duplicar huéspedes.
  if (dia >= 16) {
    return {
      origen: `${ano}_${mes}_1`,
      destino: `${ano}_${mes}_2`,
      inicioDestino:
        `${ano}-${String(mes).padStart(2, '0')}-16`,
      finOrigen:
        `${ano}-${String(mes).padStart(2, '0')}-15`
    };
  }

  if (dia >= 1 && dia <= 15) {
    const anterior = new Date(Date.UTC(ano, mes - 1, 0));
    const anoAnterior = anterior.getUTCFullYear();
    const mesAnterior = anterior.getUTCMonth() + 1;
    const ultimoDia = anterior.getUTCDate();

    return {
      origen: `${anoAnterior}_${mesAnterior}_2`,
      destino: `${ano}_${mes}_1`,
      inicioDestino:
        `${ano}-${String(mes).padStart(2, '0')}-01`,
      finOrigen:
        `${anoAnterior}-` +
        `${String(mesAnterior).padStart(2, '0')}-` +
        `${String(ultimoDia).padStart(2, '0')}`
    };
  }

  return null;
}

function claveNombre(huesped) {
  return (
    `${normalizarNombre(huesped.nombre)}|` +
    `${huesped.hostal || ''}`
  );
}

function puntuacionRegistro(huesped) {
  return (
    (huesped.fecha_salida ? 1000 : 0) +
    (huesped.fecha_entrada ? 100 : 0) +
    (huesped.fnac ? 10 : 0) +
    (huesped.cabeza ? 1 : 0)
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
    const secreto = process.env.AUTOMATION_SECRET;
    const recibido = req.headers['x-automation-secret'];

    if (!secreto || recibido !== secreto) {
      return res.status(401).json({
        ok: false,
        error: 'No autorizado'
      });
    }

    const fecha = String(
      req.body?.fecha || fechaCanarias()
    ).trim();

    if (!validarFecha(fecha)) {
      return res.status(400).json({
        ok: false,
        error: 'Fecha no válida'
      });
    }

    const cierre = datosCierre(fecha);

    const col = db.collection('huespedes');
    const cierreRef = db
      .collection('cierres_quincena')
      .doc(cierre.destino);

    const resultado = await db.runTransaction(
      async (transaction) => {
        const [origenSnap, destinoSnap, cierreSnap] =
          await Promise.all([
            transaction.get(
              col.where('quincena', '==', cierre.origen)
            ),
            transaction.get(
              col.where('quincena', '==', cierre.destino)
            ),
            transaction.get(cierreRef)
          ]);

        // Consolidar primero todas las copias del origen. Si una copia tiene
        // salida y otra no, se conserva la que contiene la salida. Solo
        // después se decide quién continúa a la nueva quincena.
        const origenConsolidado = [];
        const origenPorEstancia = new Map();
        const origenPorNombre = new Map();

        for (const [posicion, documento] of
          origenSnap.docs.entries()) {
          const huesped = documento.data();
          const estanciaId = String(huesped.estancia_id || '');
          const nombre = claveNombre(huesped);
          const orden = Number(huesped.orden);
          const ordenBase = Number.isFinite(orden)
            ? orden
            : Number.MAX_SAFE_INTEGER;
          const existente =
            (estanciaId && origenPorEstancia.get(estanciaId)) ||
            origenPorNombre.get(nombre);

          if (!existente) {
            const registro = {
              documento,
              ordenBase,
              posicion
            };

            origenConsolidado.push(registro);
            if (estanciaId) {
              origenPorEstancia.set(estanciaId, registro);
            }
            origenPorNombre.set(nombre, registro);
            continue;
          }

          existente.ordenBase = Math.min(
            existente.ordenBase,
            ordenBase
          );

          const actual = existente.documento.data();
          const puntuacionActual = puntuacionRegistro(actual);
          const puntuacionNueva = puntuacionRegistro(huesped);
          const salidaActual = String(actual.fecha_salida || '');
          const salidaNueva = String(huesped.fecha_salida || '');

          if (
            puntuacionNueva > puntuacionActual ||
            (
              puntuacionNueva === puntuacionActual &&
              salidaNueva > salidaActual
            )
          ) {
            existente.documento = documento;
          }

          if (estanciaId) {
            origenPorEstancia.set(estanciaId, existente);
          }
          origenPorNombre.set(nombre, existente);
        }

        const activos = origenConsolidado
          .sort((a, b) => {
            if (a.ordenBase !== b.ordenBase) {
              return a.ordenBase - b.ordenBase;
            }

            if (a.posicion !== b.posicion) {
              return a.posicion - b.posicion;
            }

            return String(a.documento.id).localeCompare(
              String(b.documento.id)
            );
          })
          .map((registro) => registro.documento)
          .filter((documento) => {
            const salida = String(
              documento.data().fecha_salida || ''
            );

            return !salida || salida > cierre.finOrigen;
          });

        const idsActivos = new Set();
        const nombresActivos = new Set();

        for (const documento of activos) {
          const huesped = documento.data();
          const estanciaId = String(
            huesped.estancia_id || documento.id
          );

          idsActivos.add(estanciaId);
          nombresActivos.add(claveNombre(huesped));
        }

        const destinoValido = [];
        let eliminadosObsoletos = 0;

        for (const documento of destinoSnap.docs) {
          const huesped = documento.data();
          const estanciaId = String(huesped.estancia_id || '');
          const esCopiaDeEsteCierre =
            huesped.origen_cierre === cierre.origen;
          const sigueActivo =
            (estanciaId && idsActivos.has(estanciaId)) ||
            nombresActivos.has(claveNombre(huesped));

          if (esCopiaDeEsteCierre && !sigueActivo) {
            transaction.delete(documento.ref);
            eliminadosObsoletos++;
            continue;
          }

          destinoValido.push({
            ref: documento.ref,
            id: documento.id,
            ...huesped
          });
        }

        const porEstancia = new Map();
        const porNombre = new Map();

        for (const huesped of destinoValido) {
          const estanciaId = String(huesped.estancia_id || '');

          if (estanciaId && !porEstancia.has(estanciaId)) {
            porEstancia.set(estanciaId, huesped);
          }

          const nombre = claveNombre(huesped);

          if (!porNombre.has(nombre)) {
            porNombre.set(nombre, huesped);
          }
        }

        let traspasados = 0;
        let yaExistian = 0;
        let reordenados = 0;
        let ordenDestino = 0;
        const referenciasOrdenadas = new Set();

        for (const documento of activos) {
          const huesped = documento.data();
          const estanciaId = String(
            huesped.estancia_id || documento.id
          );
          const nombre = claveNombre(huesped);
          const existente =
            porEstancia.get(estanciaId) ||
            porNombre.get(nombre);
          const ordenActual = ordenDestino++;

          if (existente) {
            const cambios = {
              estancia_id: estanciaId,
              orden: ordenActual,
              actualizado_en:
                admin.firestore.FieldValue.serverTimestamp()
            };

            if (Number(existente.orden) !== ordenActual) {
              reordenados++;
            }

            if (
              huesped.fecha_salida &&
              huesped.fecha_salida > cierre.finOrigen &&
              !existente.fecha_salida
            ) {
              cambios.fecha_salida = huesped.fecha_salida;
            }

            transaction.set(
              existente.ref,
              cambios,
              { merge: true }
            );
            referenciasOrdenadas.add(existente.ref.id);
            yaExistian++;
            continue;
          }

          const destinoId = idCopiaCierre(
            cierre.destino,
            estanciaId
          );
          const ref = col.doc(destinoId);
          const copia = {
            id: destinoId,
            nombre: huesped.nombre || '',
            nombre_normalizado: normalizarNombre(
              huesped.nombre
            ),
            estancia_id: estanciaId,
            fnac: huesped.fnac || '',
            hostal: huesped.hostal || '',
            fecha_entrada: cierre.inicioDestino,
            fecha_salida:
              huesped.fecha_salida &&
              huesped.fecha_salida > cierre.finOrigen
                ? huesped.fecha_salida
                : '',
            cabeza: Boolean(huesped.cabeza),
            picnic: false,
            min_dias: 0,
            snack_dias: 0,
            importado: Boolean(huesped.importado),
            orden: ordenActual,
            tipo_manual: huesped.tipo_manual || '',
            sin_snack: Boolean(huesped.sin_snack),
            quincena: cierre.destino,
            origen_cierre: cierre.origen,
            creado_en:
              admin.firestore.FieldValue.serverTimestamp(),
            actualizado_en:
              admin.firestore.FieldValue.serverTimestamp()
          };

          transaction.set(ref, copia, { merge: true });
          referenciasOrdenadas.add(ref.id);
          porEstancia.set(estanciaId, { ref, ...copia });
          porNombre.set(nombre, { ref, ...copia });
          traspasados++;
        }

        // Las altas propias de la nueva quincena quedan después de quienes
        // continuaban, manteniendo entre ellas su orden relativo.
        const propiosDestino = destinoValido
          .filter(
            (huesped) =>
              !referenciasOrdenadas.has(huesped.ref.id)
          )
          .sort((a, b) => {
            const ordenA = Number(a.orden);
            const ordenB = Number(b.orden);
            const valorA = Number.isFinite(ordenA)
              ? ordenA
              : Number.MAX_SAFE_INTEGER;
            const valorB = Number.isFinite(ordenB)
              ? ordenB
              : Number.MAX_SAFE_INTEGER;

            if (valorA !== valorB) return valorA - valorB;
            return String(a.id).localeCompare(String(b.id));
          });

        for (const huesped of propiosDestino) {
          const ordenActual = ordenDestino++;

          if (Number(huesped.orden) !== ordenActual) {
            transaction.set(
              huesped.ref,
              {
                orden: ordenActual,
                actualizado_en:
                  admin.firestore.FieldValue.serverTimestamp()
              },
              { merge: true }
            );
            reordenados++;
          }
        }

        const eraRepetido = Boolean(
          cierreSnap.exists &&
          cierreSnap.data().completado === true
        );

        transaction.set(
          cierreRef,
          {
            fecha_ejecucion: fecha,
            origen: cierre.origen,
            destino: cierre.destino,
            activos_en_origen: activos.length,
            traspasados,
            ya_existian: yaExistian,
            reordenados,
            eliminados_obsoletos: eliminadosObsoletos,
            completado: true,
            actualizado_en:
              admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        return {
          activos: activos.length,
          traspasados,
          yaExistian,
          reordenados,
          eliminadosObsoletos,
          repetido: eraRepetido
        };
      }
    );

    return res.status(200).json({
      ok: true,
      fecha,
      origen: cierre.origen,
      destino: cierre.destino,
      ...resultado
    });
  } catch (error) {
    console.error('Error al cerrar quincena:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudo cerrar la quincena'
    });
  }
};
