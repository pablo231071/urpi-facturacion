const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Método no permitido' });

  try {
    const { huespedes, quincena, eliminarIds = [], permitirLimpiarSalidaIds = [] } = req.body || {};
    const quincenaLimpia = String(quincena || '').trim();

    if (!/^\d{4}_(?:[1-9]|1[0-2])_[12]$/.test(quincenaLimpia)) {
      return res.status(400).json({ ok:false, error:'Quincena no válida' });
    }
    if (!Array.isArray(huespedes)) return res.status(400).json({ ok:false, error:'La lista de huéspedes no es válida' });
    if (!Array.isArray(eliminarIds) || !Array.isArray(permitirLimpiarSalidaIds)) {
      return res.status(400).json({ ok:false, error:'La operación de guardado no es válida' });
    }

    const datosValidos = huespedes.map((h, orden) => {
      const id = String(h.id || '').trim();
      const nombre = String(h.nombre || '').trim();
      const hostal = String(h.hostal || '').trim();
      if (!id || id.includes('/') || id.length > 200) throw new Error('Uno de los huéspedes tiene un identificador no válido');
      if (!nombre) throw new Error('Uno de los huéspedes no tiene nombre');
      if (!hostal) throw new Error(`Falta el hostal de ${nombre}`);
      return {
        id,
        nombre: nombre.slice(0,200),
        nombre_normalizado: normalizarNombre(nombre),
        fnac: String(h.fnac || ''),
        hostal: hostal.slice(0,100),
        fecha_entrada: String(h.fechaEntrada || ''),
        fecha_salida: String(h.fechaSalida || ''),
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

    const idsActuales = new Set(datosValidos.map((h) => h.id));
    if (idsActuales.size !== datosValidos.length) return res.status(400).json({ ok:false, error:'Hay identificadores de huéspedes duplicados' });
    if (datosValidos.length + eliminarIds.length > 400) return res.status(400).json({ ok:false, error:'Demasiados registros para guardar de forma segura en una sola operación' });

    const col = db.collection('huespedes');
    const limpiarSalida = new Set(permitirLimpiarSalidaIds.map(String));
    const idsAEliminar = new Set(eliminarIds.map(String));

    const resultado = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(col.where('quincena','==',quincenaLimpia));
      const existentesPorId = new Map(snap.docs.map((doc) => [doc.id, doc.data()]));
      const existentePorEstancia = new Map();

      for (const doc of snap.docs) {
        const data = doc.data();
        const estancia = String(data.estancia_id || '').trim();
        if (estancia && !existentePorEstancia.has(estancia)) {
          existentePorEstancia.set(estancia, { id:doc.id, data, ref:doc.ref });
        }
      }

      const vistosEnPeticion = new Set();
      const datosFinales = [];
      let duplicadosEvitados = 0;

      for (const h of datosValidos) {
        const actual = { ...h };
        const anteriorMismoId = existentesPorId.get(actual.id);
        actual.estancia_id = actual.estancia_id || anteriorMismoId?.estancia_id || actual.id || crypto.randomUUID();

        // Si la propia petición trae dos copias de la misma estancia, solo
        // procesamos la primera. Esto neutraliza dobles clics y cierres repetidos.
        if (vistosEnPeticion.has(actual.estancia_id)) {
          duplicadosEvitados++;
          continue;
        }
        vistosEnPeticion.add(actual.estancia_id);

        const existenteMismaEstancia = existentePorEstancia.get(actual.estancia_id);

        // Si llega con un ID nuevo pero la estancia ya existe en esta quincena,
        // NO creamos otro documento. Usamos el documento existente como canon.
        // Es precisamente el patrón que generaba el cierre manual antiguo.
        if (existenteMismaEstancia && existenteMismaEstancia.id !== actual.id) {
          const previa = existenteMismaEstancia.data;
          const canon = {
            ...actual,
            id: existenteMismaEstancia.id,
            estancia_id: actual.estancia_id
          };

          // Nunca borrar una salida real ya registrada.
          if (previa.fecha_salida && !canon.fecha_salida) {
            canon.fecha_salida = previa.fecha_salida;
          }

          // Conservar la entrada existente si la petición de cierre intenta
          // sustituirla por una fecha genérica y el registro ya estaba creado.
          if (previa.fecha_entrada) {
            canon.fecha_entrada = previa.fecha_entrada;
          }

          datosFinales.push(canon);
          duplicadosEvitados++;
          continue;
        }

        // Una pantalla antigua nunca puede borrar una salida registrada por
        // automatización, salvo petición manual explícita sobre ese mismo ID.
        if (anteriorMismoId?.fecha_salida && !actual.fecha_salida && !limpiarSalida.has(actual.id)) {
          actual.fecha_salida = anteriorMismoId.fecha_salida;
        }

        datosFinales.push(actual);
      }

      let eliminados = 0;

      // Guardar una lista nunca implica borrar los documentos ausentes.
      // Solo se elimina por ID explícito y dentro de la misma quincena.
      for (const doc of snap.docs) {
        if (idsAEliminar.has(doc.id)) {
          transaction.delete(doc.ref);
          eliminados++;
        }
      }

      for (const h of datosFinales) transaction.set(col.doc(h.id), h);

      return { guardados:datosFinales.length, eliminados, duplicadosEvitados };
    });

    return res.status(200).json({
      ok:true,
      guardados:resultado.guardados,
      eliminados:resultado.eliminados,
      duplicadosEvitados:resultado.duplicadosEvitados,
      copiasRetiradas:0,
      borradoMasivoDeshabilitado:true
    });
  } catch (error) {
    console.error('Error al guardar huéspedes:', error);
    return res.status(500).json({ ok:false, error:'No se pudieron guardar los huéspedes' });
  }
};
