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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { quincena } = req.query;
    if (!quincena) return res.status(400).json({ error: 'Falta quincena' });

    const snap = await db.collection('huespedes')
      .where('quincena', '==', quincena)
      .get();

    const huespedes = snap.docs
      .map(d => {
        const f = d.data();
        return {
          id: f.id || d.id,
          nombre: f.nombre || '',
          fnac: f.fnac || '',
          hostal: f.hostal || '',
          fechaEntrada: f.fecha_entrada || '',
          fechaSalida: f.fecha_salida || '',
          cabeza: f.cabeza || false,
          picnic: f.picnic || false,
          minDias: f.min_dias || 0,
          snackDias: f.snack_dias || 0,
          importado: f.importado || false,
          tipoManual: f.tipo_manual || '',
          sinSnack: f.sin_snack || false,
          orden: f.orden || 0,
          quincena: f.quincena || ''
        };
      })
      .sort((a, b) => a.orden - b.orden);

    return res.status(200).json({ ok: true, huespedes });

  } catch (e) {
    console.error('Error cargar:', e);
    return res.status(500).json({ error: e.message });
  }
}
