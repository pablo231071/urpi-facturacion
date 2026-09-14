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
    .replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function esCabecera(nombre) {
  const n = normalizarNombre(nombre)
    .replace(/[.:;,/_+|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!n) return true;

  const cabeceras = new Set([
    'NOMBRE',
    'NOMBRES',
    'APELLIDO',
    'APELLIDOS',
    'NOMBRE Y APELLIDO',
    'NOMBRE Y APELLIDOS',
    'FECHA NAC',
    'FECHA NACIMIENTO',
    'FECHA DE NACIMIENTO',
    'NACIONALIDAD',
    'NIE',
    'NIE PASAPORTE',
    'PASAPORTE',
    'HORA',
    'FECHA HORA',
    'FECHA HORA ENTRADA',
    'FECHA HORA DE ENTRADA',
    'FECHA HORA SALIDA',
    'FECHA HORA DE SALIDA'
  ]);

  if (cabeceras.has(n)) return true;

  return (
    /^NOMBRE(?:S)?(?:\s+Y\s+APELLIDO(?:S)?)?(?:\s|$)/.test(n) &&
    /(?:APELLIDO|FECHA|NAC|NACIONALIDAD|NIE|PASAPORTE|HORA)/.test(n)
  );
}

function distancia(a, b) {
  const anterior = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

  for (let i = 1; i <= a.length; i++) {
    let diagonal = anterior[0];
    anterior[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const arriba = anterior[j];

      anterior[j] = Math.min(
        anterior[j] + 1,
        anterior[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );

      diagonal = arriba;
    }
  }

  return anterior[b.length];
}

function nombresCoinciden(a, b) {
  const na = normalizarNombre(a);
  const nb = normalizarNombre(b);

  if (na === nb) return true;

  return (
    Math.min(na.length, nb.length) >= 10 &&
    distancia(na, nb) <= 1
  );
}

function quincenaDeFecha(fecha) {
  const [ano, mes, dia] = fecha.split('-').map(Number);
  return `${ano}_${mes}_${dia <= 15 ? 1 : 2}`;
}

function siguienteQuincena(clave) {
  const [ano, mes, tipo] = clave.split('_').map(Number);

  if (tipo === 1) return `${ano}_${mes}_2`;

  return mes === 12
    ? `${ano + 1}_1_1`
    : `${ano}_${mes + 1}_1`;
}

function quincenaAnterior(clave) {
  const [ano, mes, tipo] = clave.split('_').map(Number);

  if (tipo === 2) return `${ano}_${mes}_1`;

  return mes === 1
    ? `${ano - 1}_12_2`
    : `${ano}_${mes - 1}_2`;
}

function inicioDeQuincena(fecha) {
  const [ano, mes, dia] = fecha.split('-').map(Number);

  return (
    `${ano}-${String(mes).padStart(2, '0')}-` +
    `${dia <= 15 ? '01' : '16'}`
  );
}

function diaAnterior(fecha) {
  const [ano, mes, dia] = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));

  d.setUTCDate(d.getUTCDate() - 1);

  return d.toISOString().slice(0, 10);
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

function idCopiaCierre(quincena, estanciaId) {
  return `cierre_${quincena}_${estanciaId}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 140);
}

function convertirSnap(snap) {
  return snap.docs.map((documento) => ({
    ref: documento.ref,
    id: documento.id,
    ...documento.data()
  }));
}

function buscarActivo(registros, persona, hostal) {
  const coincidencias = registros.filter(
    (h) =>
      nombresCoinciden(h.nombre, persona.nombre) &&
      !h.fecha_salida
  );

  return (
    coincidencias.find((h) => h.hostal === hostal) ||
    (coincidencias.length === 1 ? coincidencias[0] : null)
  );
}

function buscarPorIdentidad(registros, persona, hostal) {
  const coincidencias = registros.filter((h) =>
    nombresCoinciden(h.nombre, persona.nombre)
  );

  return (
    coincidencias.find((h) => h.hostal === hostal) ||
    (coincidencias.length === 1 ? coincidencias[0] : null)
  );
}

function mismaEstancia(huesped, persona, hostal, estanciaId) {
  return (
    (
      estanciaId &&
      String(huesped.estancia_id || '') === String(estanciaId)
    ) ||
    (
      huesped.hostal === hostal &&
      nombresCoinciden(huesped.nombre, persona.nombre)
    )
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

    const { tipo, hostal, fecha, personas } = req.body || {};
    const tipoLimpio = String(tipo || '').trim().toUpperCase();
    const hostalLimpio = String(hostal || '').trim();
    const fechaLimpia = String(fecha || '').trim();

    if (!['INICIO', 'FIN'].includes(tipoLimpio)) {
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

    if (!Array.isArray(personas) || personas.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Lista de personas no válida'
      });
    }

    const personasLimpias = personas
      .map((p) => ({
        nombre: String(p.nombre || '')
          .replace(/\s+/g, ' ')
          .trim(),
        fnac: String(p.fnac || '').trim(),
        cabeza: Boolean(p.cabeza),
        picnic: Boolean(p.picnic)
      }))
      .filter((p) => p.nombre && !esCabecera(p.nombre));

    if (
      personasLimpias.length === 0 ||
      personasLimpias.length > 100
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'No se detectaron huéspedes válidos en el correo'
      });
    }

    const quincena = quincenaDeFecha(fechaLimpia);
    const anterior = quincenaAnterior(quincena);
    const siguiente = siguienteQuincena(quincena);
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

    const huespedesCol = db.collection('huespedes');
    const eventoRef = db
      .collection('eventos_correo')
      .doc(huella);

    const resultado = await db.runTransaction(
      async (transaction) => {
        const eventoSnap = await transaction.get(eventoRef);
        let procesadosPrevios = [];
        let personasAProcesar = personasLimpias;
        let esReintento = false;

        if (eventoSnap.exists) {
          procesadosPrevios = Array.isArray(
            eventoSnap.data().procesados
          )
            ? eventoSnap.data().procesados
            : [];

          const pendientes = new Set(
            procesadosPrevios
              .filter(
                (p) => p && p.accion === 'no encontrado'
              )
              .map((p) => normalizarNombre(p.nombre))
          );

          if (pendientes.size === 0) {
            return {
              duplicado: true,
              procesados: procesadosPrevios
            };
          }

          personasAProcesar = personasLimpias.filter((p) =>
            pendientes.has(normalizarNombre(p.nombre))
          );

          procesadosPrevios = procesadosPrevios.filter(
            (p) =>
              !pendientes.has(normalizarNombre(p.nombre))
          );

          esReintento = true;
        }

        const [quincenaSnap, anteriorSnap, siguienteSnap] =
          await Promise.all([
            transaction.get(
              huespedesCol.where(
                'quincena',
                '==',
                quincena
              )
            ),
            transaction.get(
              huespedesCol.where(
                'quincena',
                '==',
                anterior
              )
            ),
            transaction.get(
              huespedesCol.where(
                'quincena',
                '==',
                siguiente
              )
            )
          ]);

        const registros = convertirSnap(quincenaSnap);
        const registrosAnteriores = convertirSnap(anteriorSnap);
        const registrosSiguientes = convertirSnap(siguienteSnap);
        const procesados = [];

        for (const persona of personasAProcesar) {
          const clave = normalizarNombre(persona.nombre);
          let existente = buscarActivo(
            registros,
            persona,
            hostalLimpio
          );
          let encontradoEn = quincena;

          if (!existente) {
            existente = buscarActivo(
              registrosAnteriores,
              persona,
              hostalLimpio
            );
            encontradoEn = anterior;
          }

          if (tipoLimpio === 'FIN') {
            if (!existente) {
              existente = buscarPorIdentidad(
                registros,
                persona,
                hostalLimpio
              );
              encontradoEn = quincena;
            }

            if (!existente) {
              existente = buscarPorIdentidad(
                registrosAnteriores,
                persona,
                hostalLimpio
              );
              encontradoEn = anterior;
            }

            if (!existente) {
              procesados.push({
                nombre: persona.nombre,
                accion: 'no encontrado'
              });
              continue;
            }

            const estanciaId = String(
              existente.estancia_id || existente.id
            );
            const salidaCambios = {
              fecha_salida: fechaLimpia,
              estancia_id: estanciaId,
              picnic: Boolean(
                existente.picnic || persona.picnic
              ),
              actualizado_en:
                admin.firestore.FieldValue.serverTimestamp()
            };

            transaction.update(existente.ref, salidaCambios);

            if (encontradoEn === anterior) {
              let copiaActual = registros.find((h) =>
                mismaEstancia(
                  h,
                  persona,
                  existente.hostal,
                  estanciaId
                )
              );

              if (copiaActual) {
                transaction.update(copiaActual.ref, {
                  fecha_salida: fechaLimpia,
                  estancia_id: estanciaId,
                  picnic: Boolean(
                    copiaActual.picnic || persona.picnic
                  ),
                  actualizado_en:
                    admin.firestore.FieldValue.serverTimestamp()
                });
              } else {
                const copiaId = idCopiaCierre(
                  quincena,
                  estanciaId
                );
                const copiaRef = huespedesCol.doc(copiaId);
                const copia = {
                  id: copiaId,
                  nombre: existente.nombre || persona.nombre,
                  nombre_normalizado: normalizarNombre(
                    existente.nombre || persona.nombre
                  ),
                  estancia_id: estanciaId,
                  fnac: existente.fnac || persona.fnac || '',
                  hostal: existente.hostal || hostalLimpio,
                  fecha_entrada: inicioDeQuincena(fechaLimpia),
                  fecha_salida: fechaLimpia,
                  cabeza: Boolean(existente.cabeza),
                  picnic: Boolean(persona.picnic),
                  min_dias: 0,
                  snack_dias: 0,
                  importado: Boolean(existente.importado),
                  orden: registros.length,
                  tipo_manual: existente.tipo_manual || '',
                  sin_snack: Boolean(existente.sin_snack),
                  quincena,
                  origen_cierre: anterior,
                  creado_en:
                    admin.firestore.FieldValue.serverTimestamp(),
                  actualizado_en:
                    admin.firestore.FieldValue.serverTimestamp()
                };

                transaction.set(copiaRef, copia, { merge: true });
                copiaActual = { ref: copiaRef, ...copia };
                registros.push(copiaActual);
              }
            }

            for (const copia of registrosSiguientes) {
              if (
                copia.origen_cierre === quincena &&
                mismaEstancia(
                  copia,
                  persona,
                  existente.hostal,
                  estanciaId
                )
              ) {
                transaction.delete(copia.ref);
              }
            }

            existente.fecha_salida = fechaLimpia;
            procesados.push({
              nombre: persona.nombre,
              accion:
                encontradoEn === anterior
                  ? 'salida registrada y recuperada en la quincena correcta'
                  : 'salida registrada'
            });
            continue;
          }

          if (
            existente &&
            existente.hostal === hostalLimpio &&
            encontradoEn === quincena
          ) {
            const cambios = {
              estancia_id:
                existente.estancia_id || existente.id,
              actualizado_en:
                admin.firestore.FieldValue.serverTimestamp()
            };

            if (!existente.fecha_entrada) {
              cambios.fecha_entrada = fechaLimpia;
            }

            if (!existente.fnac && persona.fnac) {
              cambios.fnac = persona.fnac;
            }

            if (persona.cabeza) cambios.cabeza = true;

            transaction.update(existente.ref, cambios);
            procesados.push({
              nombre: persona.nombre,
              accion: 'huésped actualizado'
            });
            continue;
          }

          if (
            existente &&
            existente.hostal === hostalLimpio &&
            encontradoEn === anterior
          ) {
            const estanciaId = String(
              existente.estancia_id || existente.id
            );
            const copiaActual = registros.find((h) =>
              mismaEstancia(
                h,
                persona,
                hostalLimpio,
                estanciaId
              )
            );

            if (copiaActual) {
              transaction.update(copiaActual.ref, {
                estancia_id: estanciaId,
                fnac: copiaActual.fnac || persona.fnac || '',
                cabeza: Boolean(
                  copiaActual.cabeza || persona.cabeza
                ),
                actualizado_en:
                  admin.firestore.FieldValue.serverTimestamp()
              });
            } else {
              const copiaId = idCopiaCierre(
                quincena,
                estanciaId
              );
              const copiaRef = huespedesCol.doc(copiaId);
              const copia = {
                id: copiaId,
                nombre: existente.nombre || persona.nombre,
                nombre_normalizado: normalizarNombre(
                  existente.nombre || persona.nombre
                ),
                estancia_id: estanciaId,
                fnac: existente.fnac || persona.fnac || '',
                hostal: hostalLimpio,
                fecha_entrada: inicioDeQuincena(fechaLimpia),
                fecha_salida: '',
                cabeza: Boolean(
                  existente.cabeza || persona.cabeza
                ),
                picnic: false,
                min_dias: 0,
                snack_dias: 0,
                importado: Boolean(existente.importado),
                orden: registros.length,
                tipo_manual: existente.tipo_manual || '',
                sin_snack: Boolean(existente.sin_snack),
                quincena,
                origen_cierre: anterior,
                creado_en:
                  admin.firestore.FieldValue.serverTimestamp(),
                actualizado_en:
                  admin.firestore.FieldValue.serverTimestamp()
              };

              transaction.set(copiaRef, copia, { merge: true });
              registros.push({ ref: copiaRef, ...copia });
            }

            procesados.push({
              nombre: persona.nombre,
              accion: 'huésped recuperado en la quincena actual'
            });
            continue;
          }

          if (existente && existente.hostal !== hostalLimpio) {
            transaction.update(existente.ref, {
              fecha_salida: diaAnterior(fechaLimpia),
              picnic: false,
              actualizado_en:
                admin.firestore.FieldValue.serverTimestamp()
            });
            existente.fecha_salida = diaAnterior(fechaLimpia);
          }

          const nuevaRef = huespedesCol.doc();
          const nuevoHuesped = {
            id: nuevaRef.id,
            nombre: persona.nombre,
            nombre_normalizado: clave,
            estancia_id: nuevaRef.id,
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
              admin.firestore.FieldValue.serverTimestamp(),
            actualizado_en:
              admin.firestore.FieldValue.serverTimestamp()
          };

          transaction.set(nuevaRef, nuevoHuesped);
          registros.push({ ref: nuevaRef, ...nuevoHuesped });
          procesados.push({
            nombre: persona.nombre,
            accion: existente
              ? 'traslado registrado'
              : 'nuevo huésped creado'
          });
        }

        const procesadosFinales = [
          ...procesadosPrevios,
          ...procesados
        ];

        transaction.set(eventoRef, {
          tipo: tipoLimpio,
          hostal: hostalLimpio,
          fecha: fechaLimpia,
          quincena,
          procesados: procesadosFinales,
          creado_en: eventoSnap.exists
            ? (
                eventoSnap.data().creado_en ||
                admin.firestore.FieldValue.serverTimestamp()
              )
            : admin.firestore.FieldValue.serverTimestamp(),
          actualizado_en:
            admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          duplicado: false,
          reintento: esReintento,
          procesados: procesadosFinales
        };
      }
    );

    return res.status(200).json({
      ok: true,
      quincena,
      duplicado: resultado.duplicado,
      reintento: Boolean(resultado.reintento),
      cabecerasDescartadas:
        personas.length - personasLimpias.length,
      procesados: resultado.procesados
    });
  } catch (error) {
    console.error('Error en movimiento:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudo procesar el movimiento'
    });
  }
};
