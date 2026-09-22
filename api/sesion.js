const {
  compararSeguro,
  crearToken,
  cookieSesion,
  cookieCaducada
} = require('./_sesion');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Automation-Secret'
  );
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', cookieCaducada());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido'
    });
  }

  const secreto = process.env.AUTOMATION_SECRET;
  const recibido = req.headers['x-automation-secret'];

  if (!secreto || !compararSeguro(recibido, secreto)) {
    return res.status(401).json({
      ok: false,
      error: 'No autorizado'
    });
  }

  res.setHeader(
    'Set-Cookie',
    cookieSesion(crearToken(secreto))
  );

  return res.status(200).json({
    ok: true,
    recordadoDias: 180
  });
};
