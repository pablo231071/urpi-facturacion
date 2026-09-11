const admin = require('firebase-admin');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

function normalizarNombre(valor) {
  return String(valor || '').replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
}
function fechaCanarias(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Atlantic/Canary',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const g=t=>p.find(x=>x.type===t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}
function validarFecha(fecha){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha))return false;
  const [a,m,d]=fecha.split('-').map(Number),x=new Date(Date.UTC(a,m-1,d));
  return x.getUTCFullYear()===a&&x.getUTCMonth()===m-1&&x.getUTCDate()===d;
}
function datosCierre(fecha){
  const [a,m,d]=fecha.split('-').map(Number);
  if(d===16)return{origen:`${a}_${m}_1`,destino:`${a}_${m}_2`,inicioDestino:`${a}-${String(m).padStart(2,'0')}-16`,finOrigen:`${a}-${String(m).padStart(2,'0')}-15`};
  if(d===1){const x=new Date(Date.UTC(a,m-1,0)),aa=x.getUTCFullYear(),mm=x.getUTCMonth()+1,ud=x.getUTCDate();return{origen:`${aa}_${mm}_2`,destino:`${a}_${m}_1`,inicioDestino:`${a}-${String(m).padStart(2,'0')}-01`,finOrigen:`${aa}-${String(mm).padStart(2,'0')}-${String(ud).padStart(2,'0')}`};}
  return null;
}

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Automation-Secret');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'Método no permitido'});
  try{
    const secreto=process.env.AUTOMATION_SECRET, recibido=req.headers['x-automation-secret'];
    if(!secreto||recibido!==secreto)return res.status(401).json({ok:false,error:'No autorizado'});
    const fecha=String(req.body?.fecha||fechaCanarias()).trim();
    if(!validarFecha(fecha))return res.status(400).json({ok:false,error:'Fecha no válida'});
    const cierre=datosCierre(fecha);
    if(!cierre)return res.status(400).json({ok:false,error:'El cierre solo puede ejecutarse los días 1 y 16'});

    const col=db.collection('huespedes'), cierreRef=db.collection('cierres_quincena').doc(cierre.destino);
    const resultado=await db.runTransaction(async transaction=>{
      const [origenSnap,destinoSnap,cierreSnap]=await Promise.all([
        transaction.get(col.where('quincena','==',cierre.origen)),
        transaction.get(col.where('quincena','==',cierre.destino)),
        transaction.get(cierreRef)
      ]);

      // Si ya se ejecutó este mismo cierre, no vuelve a crear nada. Así una
      // repetición de Activepieces o un reintento de red es inocuo.
      if(cierreSnap.exists&&cierreSnap.data().completado===true){
        return{activos:cierreSnap.data().activos_en_origen||0,traspasados:0,yaExistian:destinoSnap.size,repetido:true};
      }

      const ids=new Set(), nombres=new Set();
      destinoSnap.docs.forEach(doc=>{const h=doc.data();if(h.estancia_id)ids.add(String(h.estancia_id));nombres.add(`${normalizarNombre(h.nombre)}|${h.hostal||''}`);});
      const activos=origenSnap.docs.filter(doc=>{const s=String(doc.data().fecha_salida||'');return !s||s>cierre.finOrigen;});
      let traspasados=0,yaExistian=0;

      for(const doc of activos){
        const h=doc.data(), estancia=String(h.estancia_id||doc.id), clave=`${normalizarNombre(h.nombre)}|${h.hostal||''}`;
        if(ids.has(estancia)||nombres.has(clave)){yaExistian++;continue;}
        // ID determinista: una estancia solo puede tener una copia por destino.
        const destinoId=`cierre_${cierre.destino}_${estancia}`.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,140);
        const ref=col.doc(destinoId);
        transaction.set(ref,{
          id:destinoId,nombre:h.nombre||'',nombre_normalizado:normalizarNombre(h.nombre),estancia_id:estancia,fnac:h.fnac||'',hostal:h.hostal||'',
          fecha_entrada:cierre.inicioDestino,fecha_salida:(h.fecha_salida&&h.fecha_salida>cierre.finOrigen)?h.fecha_salida:'',cabeza:Boolean(h.cabeza),picnic:false,min_dias:0,snack_dias:0,
          importado:Boolean(h.importado),orden:destinoSnap.size+traspasados,tipo_manual:h.tipo_manual||'',sin_snack:Boolean(h.sin_snack),quincena:cierre.destino,origen_cierre:cierre.origen,
          creado_en:admin.firestore.FieldValue.serverTimestamp(),actualizado_en:admin.firestore.FieldValue.serverTimestamp()
        },{merge:true});
        ids.add(estancia);nombres.add(clave);traspasados++;
      }

      transaction.set(cierreRef,{fecha_ejecucion:fecha,origen:cierre.origen,destino:cierre.destino,activos_en_origen:activos.length,traspasados,ya_existian:yaExistian,completado:true,actualizado_en:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return{activos:activos.length,traspasados,yaExistian,repetido:false};
    });
    return res.status(200).json({ok:true,fecha,origen:cierre.origen,destino:cierre.destino,...resultado});
  }catch(error){console.error('Error al cerrar quincena:',error);return res.status(500).json({ok:false,error:'No se pudo cerrar la quincena'});}
};
