const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { huespedes, quincena } = req.body;

    if (!quincena) return res.status(400).json({ error: 'Falta quincena' });

    const col = db.collection('huespedes');

    // 1. Leer IDs existentes de esta quincena
    const snap = await col.where('quincena', '==', quincena).get();
    const idsExist = new Set(snap.docs.map(d => d.id));
    const idsActuales = new Set((huespedes || []).map(h => String(h.id)));

    // 2. Borrar los que ya no están — en batch
    const aBorrar = snap.docs.filter(d => !idsActuales.has(d.id));
    if (aBorrar.length > 0) {
      const delBatch = db.batch();
      aBorrar.forEach(d => delBatch.delete(col.doc(d.id)));
      await delBatch.commit();
    }

    // 3. Guardar todos en batches de 500 (límite Firestore)
    const BATCH_SIZE = 500;
    for (let i = 0; i < (huespedes || []).length; i += BATCH_SIZE) {
      const batch = db.batch();
      huespedes.slice(i, i + BATCH_SIZE).forEach((h, li) => {
        const id = String(h.id);
        batch.set(col.doc(id), {
          id,
          nombre: h.nombre || '',
          fnac: h.fnac || '',
          hostal: h.hostal || '',
          fecha_entrada: h.fechaEntrada || '',
          fecha_salida: h.fechaSalida || '',
          cabeza: !!h.cabeza,
          picnic: !!h.picnic,
          min_dias: h.minDias || 0,
          snack_dias: h.snackDias || 0,
          importado: !!h.importado,
          orden: i + li,
          tipo_manual: h.tipoManual || '',
          sin_snack: !!h.sinSnack,
          quincena
        });
      });
      await batch.commit();
    }

    return res.status(200).json({ ok: true, guardados: (huespedes || []).length });

  } catch (e) {
    console.error('Error guardar:', e);
    return res.status(500).json({ error: e.message });
  }
}
