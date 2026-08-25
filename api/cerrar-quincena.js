const admin = require('firebase-admin');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error(
      'Falta la variable FIREBASE_SERVICE_ACCOUNT'
    );
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential:
      admin.credential.cert(serviceAccount)
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

function fechaCanarias() {
  const partes = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Atlantic/Canary',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(new Date());

  const obtener = (tipo) =>
    partes.find(
      (parte) => parte.type === tipo
    ).value;

  return `${obtener('year')}-${obtener('month')}-${obtener('day')}`;
}

function validarFecha(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return false;
  }

  const [ano, mes, dia] =
    fecha.split('-').map(Number);

  const fechaComprobacion =
    new Date(
      Date.UTC(ano, mes - 1, dia)
    );

  return (
    fechaComprobacion.getUTCFullYear() === ano &&
    fechaComprobacion.getUTCMonth() === mes - 1 &&
    fechaComprobacion.getUTCDate() === dia
  );
}

function datosCierre(fecha) {
  const [ano, mes, dia] =
    fecha.split('-').map(Number);

  if (dia === 16) {
    return {
      origen: `${ano}_${mes}_1`,
      destino: `${ano}_${mes}_2`,

      inicioDestino:
        `${ano}-${String(mes).padStart(2, '0')}-16`,

      finOrigen:
        `${ano}-${String(mes).padStart(2, '0')}-15`
    };
  }

  if (dia === 1) {
    const mesAnterior =
      new Date(
        Date.UTC(ano, mes - 1, 0)
      );

    const anoAnterior =
      mesAnterior.getUTCFullYear();

    const numeroMesAnterior =
      mesAnterior.getUTCMonth() + 1;

    const ultimoDiaAnterior =
      mesAnterior.getUTCDate();

    return {
      origen:
        `${anoAnterior}_${numeroMesAnterior}_2`,

      destino:
        `${ano}_${mes}_1`,

      inicioDestino:
        `${ano}-${String(mes).padStart(2, '0')}-01`,

      finOrigen:
        `${anoAnterior}-${String(numeroMesAnterior).padStart(2, '0')}-${String(ultimoDiaAnterior).padStart(2, '0')}`
    };
  }

  return null;
}

module.exports =
  async function handler(req, res) {
    res.setHeader(
      'Access-Control-Allow-Methods',
      'POST, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Automation-Secret'
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

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

      const fecha = String(
        req.body?.fecha ||
        fechaCanarias()
      ).trim();

      if (!validarFecha(fecha)) {
        return res.status(400).json({
          ok: false,
          error: 'Fecha no válida'
        });
      }

      const cierre =
        datosCierre(fecha);

      if (!cierre) {
        return res.status(400).json({
          ok: false,
          error:
            'El cierre solo puede ejecutarse los días 1 y 16'
        });
      }

      const huespedes =
        db.collection('huespedes');

      const cierreRef =
        db.collection('cierres_quincena')
          .doc(cierre.destino);

      const resultado =
        await db.runTransaction(
          async (transaction) => {
            const origenSnap =
              await transaction.get(
                huespedes.where(
                  'quincena',
                  '==',
                  cierre.origen
                )
              );

            const destinoSnap =
              await transaction.get(
                huespedes.where(
                  'quincena',
                  '==',
                  cierre.destino
                )
              );

            const existentes =
              new Set(
                destinoSnap.docs.map(
                  (documento) => {
                    const huesped =
                      documento.data();

                    return (
                      `${normalizarNombre(huesped.nombre)}|` +
                      `${huesped.hostal || ''}`
                    );
                  }
                )
              );

            const activos =
              origenSnap.docs.filter(
                (documento) => {
                  const salida = String(
                    documento.data()
                      .fecha_salida || ''
                  );

                  return (
                    !salida ||
                    salida > cierre.finOrigen
                  );
                }
              );

            let traspasados = 0;
            let yaExistian = 0;

            for (
              const documento of activos
            ) {
              const huesped =
                documento.data();

              const clave =
                `${normalizarNombre(huesped.nombre)}|` +
                `${huesped.hostal || ''}`;

              if (existentes.has(clave)) {
                yaExistian++;
                continue;
              }

              const nuevaReferencia =
                huespedes.doc();

              transaction.set(
                nuevaReferencia,
                {
                  id:
                    nuevaReferencia.id,

                  nombre:
                    huesped.nombre || '',

                  nombre_normalizado:
                    normalizarNombre(
                      huesped.nombre
                    ),

                  fnac:
                    huesped.fnac || '',

                  hostal:
                    huesped.hostal || '',

                  fecha_entrada:
                    cierre.inicioDestino,

                  fecha_salida:
                    (
                      huesped.fecha_salida &&
                      huesped.fecha_salida >
                        cierre.finOrigen
                    )
                      ? huesped.fecha_salida
                      : '',

                  cabeza:
                    Boolean(
                      huesped.cabeza
                    ),

                  picnic: false,

                  min_dias: 0,

                  snack_dias: 0,

                  importado:
                    Boolean(
                      huesped.importado
                    ),

                  orden:
                    destinoSnap.size +
                    traspasados,

                  tipo_manual:
                    huesped.tipo_manual || '',

                  sin_snack:
                    Boolean(
                      huesped.sin_snack
                    ),

                  quincena:
                    cierre.destino,

                  origen_cierre:
                    cierre.origen,

                  creado_en:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp(),

                  actualizado_en:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp()
                }
              );

              existentes.add(clave);
              traspasados++;
            }

            transaction.set(
              cierreRef,
              {
                fecha_ejecucion:
                  fecha,

                origen:
                  cierre.origen,

                destino:
                  cierre.destino,

                activos_en_origen:
                  activos.length,

                traspasados,

                ya_existian:
                  yaExistian,

                actualizado_en:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp()
              },
              {
                merge: true
              }
            );

            return {
              activos:
                activos.length,

              traspasados,

              yaExistian
            };
          }
        );

      return res.status(200).json({
        ok: true,

        fecha,

        origen:
          cierre.origen,

        destino:
          cierre.destino,

        activos:
          resultado.activos,

        traspasados:
          resultado.traspasados,

        yaExistian:
          resultado.yaExistian
      });
    } catch (error) {
      console.error(
        'Error al cerrar quincena:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'No se pudo cerrar la quincena'
      });
    }
  };
