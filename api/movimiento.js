const admin = require('firebase-admin');
const crypto = require('crypto');

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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function quincenaDeFecha(fecha) {
  const [ano, mes, dia] = fecha
    .split('-')
    .map(Number);

  return `${ano}_${mes}_${dia <= 15 ? 1 : 2}`;
}

function diaAnterior(fecha) {
  const [ano, mes, dia] = fecha
    .split('-')
    .map(Number);

  const d = new Date(
    Date.UTC(ano, mes - 1, dia)
  );

  d.setUTCDate(d.getUTCDate() - 1);

  return d.toISOString().slice(0, 10);
}

function validarFecha(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return false;
  }

  const [ano, mes, dia] = fecha
    .split('-')
    .map(Number);

  const d = new Date(
    Date.UTC(ano, mes - 1, dia)
  );

  return (
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia
  );
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

    const secretoRecibido =
      req.headers['x-automation-secret'];

    if (
      !secretoConfigurado ||
      secretoRecibido !== secretoConfigurado
    ) {
      return res.status(401).json({
        ok: false,
        error: 'No autorizado'
      });
    }

    const {
      tipo,
      hostal,
      fecha,
      personas
    } = req.body || {};

    const tipoLimpio =
      String(tipo || '').trim().toUpperCase();

    const hostalLimpio =
      String(hostal || '').trim();

    const fechaLimpia =
      String(fecha || '').trim();

    if (
      !['INICIO', 'FIN'].includes(tipoLimpio)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Tipo de movimiento no válido'
      });
    }

    if (!validarFecha(fechaLimpia)) {
      return res.status(400).json({
        ok: false,
        error: 'Fecha no válida'
      });
    }

    if (!hostalLimpio) {
      return res.status(400).json({
        ok: false,
        error: 'Falta el hostal'
      });
    }

    if (
      !Array.isArray(personas) ||
      personas.length === 0 ||
      personas.length > 100
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Lista de personas no válida'
      });
    }

    const personasLimpias =
      personas.map((persona) => ({
        nombre: String(persona.nombre || '')
          .replace(/\s+/g, ' ')
          .trim(),

        fnac: String(persona.fnac || '').trim(),

        cabeza: Boolean(persona.cabeza),

        picnic: Boolean(persona.picnic)
      }));

    if (
      personasLimpias.some(
        (persona) => !persona.nombre
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Hay una persona sin nombre'
      });
    }

    const quincena =
      quincenaDeFecha(fechaLimpia);

    const huella = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          tipo: tipoLimpio,
          hostal: hostalLimpio,
          fecha: fechaLimpia,
          personas: personasLimpias
        })
      )
      .digest('hex');

    const huespedesCol =
      db.collection('huespedes');

    const eventoRef =
      db.collection('eventos_correo').doc(huella);

    const resultado =
      await db.runTransaction(
        async (transaction) => {
          const eventoSnap =
            await transaction.get(eventoRef);

          if (eventoSnap.exists) {
            return {
              duplicado: true,
              procesados:
                eventoSnap.data().procesados || []
            };
          }

          const consulta =
            huespedesCol.where(
              'quincena',
              '==',
              quincena
            );

          const quincenaSnap =
            await transaction.get(consulta);

          const registros =
            quincenaSnap.docs.map((documento) => ({
              ref: documento.ref,
              id: documento.id,
              ...documento.data()
            }));

          const procesados = [];

          for (
            const persona of personasLimpias
          ) {
            const clave =
              normalizarNombre(persona.nombre);

            let existente =
              registros.find((huesped) =>
                normalizarNombre(
                  huesped.nombre
                ) === clave &&
                !huesped.fecha_salida &&
                huesped.hostal === hostalLimpio
              );

            if (!existente) {
              existente =
                registros.find((huesped) =>
                  normalizarNombre(
                    huesped.nombre
                  ) === clave &&
                  !huesped.fecha_salida
                );
            }

            if (tipoLimpio === 'FIN') {
              if (!existente) {
                procesados.push({
                  nombre: persona.nombre,
                  accion: 'no encontrado'
                });

                continue;
              }

              transaction.update(
                existente.ref,
                {
                  fecha_salida: fechaLimpia,

                  picnic: Boolean(
                    existente.picnic ||
                    persona.picnic
                  ),

                  actualizado_en:
                    admin.firestore.FieldValue
                      .serverTimestamp()
                }
              );

              existente.fecha_salida =
                fechaLimpia;

              procesados.push({
                nombre: persona.nombre,
                accion: 'salida registrada'
              });

              continue;
            }

            if (
              existente &&
              existente.hostal === hostalLimpio
            ) {
              const cambios = {
                actualizado_en:
                  admin.firestore.FieldValue
                    .serverTimestamp()
              };

              if (!existente.fecha_entrada) {
                cambios.fecha_entrada =
                  fechaLimpia;
              }

              if (
                !existente.fnac &&
                persona.fnac
              ) {
                cambios.fnac = persona.fnac;
              }

              if (persona.cabeza) {
                cambios.cabeza = true;
              }

              transaction.update(
                existente.ref,
                cambios
              );

              procesados.push({
                nombre: persona.nombre,
                accion: 'huésped actualizado'
              });

              continue;
            }

            if (
              existente &&
              existente.hostal !== hostalLimpio
            ) {
              transaction.update(
                existente.ref,
                {
                  fecha_salida:
                    diaAnterior(fechaLimpia),

                  picnic: false,

                  actualizado_en:
                    admin.firestore.FieldValue
                      .serverTimestamp()
                }
              );

              existente.fecha_salida =
                diaAnterior(fechaLimpia);
            }

            const nuevaRef =
              huespedesCol.doc();

            const nuevoHuesped = {
              id: nuevaRef.id,

              nombre: persona.nombre,

              nombre_normalizado: clave,

              fnac: persona.fnac,

              hostal: hostalLimpio,

              fecha_entrada: fechaLimpia,

              fecha_salida: '',

              cabeza: persona.cabeza,

              picnic: false,

              min_dias: 0,

              snack_dias: 0,

              importado: false,

              orden: registros.length,

              tipo_manual: '',

              sin_snack: false,

              quincena,

              creado_en:
                admin.firestore.FieldValue
                  .serverTimestamp(),

              actualizado_en:
                admin.firestore.FieldValue
                  .serverTimestamp()
            };

            transaction.set(
              nuevaRef,
              nuevoHuesped
            );

            registros.push({
              ref: nuevaRef,
              ...nuevoHuesped
            });

            procesados.push({
              nombre: persona.nombre,

              accion: existente
                ? 'traslado registrado'
                : 'nuevo huésped creado'
            });
          }

          transaction.set(
            eventoRef,
            {
              tipo: tipoLimpio,

              hostal: hostalLimpio,

              fecha: fechaLimpia,

              quincena,

              procesados,

              creado_en:
                admin.firestore.FieldValue
                  .serverTimestamp()
            }
          );

          return {
            duplicado: false,
            procesados
          };
        }
      );

    return res.status(200).json({
      ok: true,
      quincena,
      duplicado: resultado.duplicado,
      procesados: resultado.procesados
    });
  } catch (error) {
    console.error(
      'Error en movimiento:',
      error
    );

    return res.status(500).json({
      ok: false,
      error: 'No se pudo procesar el movimiento'
    });
  }
};
