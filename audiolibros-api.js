// Subida de audiolibros desde el celu (solo con el PIN del panel de administración).
// Los archivos se guardan en GitHub (repo del sitio) para que no se pierdan cuando Render reinicia.
// Si falta GITHUB_TOKEN en Render, esto no hace nada y el resto del sitio anda igual.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, 'public');
const AUDIO_DIR = path.join(PUBLIC, 'audiolibros');
const MANIFEST_REL = 'public/audiolibros/libros.json';
const MANIFEST = path.join(__dirname, MANIFEST_REL);
const APPS_SCRIPT = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzV_CxuKYu5uEjWOswbSZZLatlc8i5TvjT-Ldt_Ihre0RS-18eZy4AaOKvFmpfY-ikp/exec';
const GH_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const REPO = process.env.GITHUB_REPO || 'nicocontorti-stack/La-ruta-del-bienestar';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

const MAX_BYTES = 95 * 1024 * 1024;      // GitHub rechaza archivos de 100 MB o más
const MAX_PARTE = 12 * 1024 * 1024;      // tamaño máximo de cada pedazo que sube el celu
const PARTE = 6 * 1024 * 1024;           // tamaño que pide la página
const SESION_MS = 2 * 60 * 60 * 1000;
const TMP = path.join(os.tmpdir(), 'audiolibros-subida');

// Libros que ya están en audiolibros.html (no se tocan; solo sirven para elegirlos en el formulario)
const LEGACY = [
  { id: 'vuelta80', categoria: 'novela', titulo: 'La vuelta al mundo en 80 días', archivo: 'capitulo-', completo: false },
  { id: 'lenguaje-corporal', categoria: 'autoayuda', titulo: 'Lenguaje corporal', archivo: 'parte-', completo: false },
  { id: 'ganar-amigos', categoria: 'autoayuda', titulo: 'Cómo ganar amigos e influir sobre las personas', archivo: 'audio-', completo: true }
];
const CATS_BASE = [{ id: 'novela', nombre: 'Novela', icono: '📖' }, { id: 'autoayuda', nombre: 'Autoayuda', icono: '🌱' }];

const sesiones = new Map();   // token -> vence
const fallos = new Map();     // ip -> {n, hasta}
const subidas = new Map();    // id -> estado
let ocupado = false;          // una sola publicación a la vez
let actual = null;

// ---------- Manifiesto (libros agregados desde el celu) ----------
let manifiesto = { categorias: [], libros: [] };
function leerManifiesto() {
  try {
    const j = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    manifiesto = { categorias: Array.isArray(j.categorias) ? j.categorias : [], libros: Array.isArray(j.libros) ? j.libros : [] };
  } catch (e) { manifiesto = { categorias: [], libros: [] }; }
}
leerManifiesto();

// Agrega al HTML de la biblioteca los libros/categorías nuevos sin tocar audiolibros.html.
function inyectar(html) {
  const extra = JSON.stringify({ categorias: manifiesto.categorias, libros: manifiesto.libros }).replace(/</g, '\\u003c');
  let h = html;
  if (h.indexOf('var LIBROS = [') === -1 || h.indexOf('function buscarLibro(id)') === -1) return h;
  h = h.replace('var LIBROS = [', 'var EXTRA = ' + extra + '; EXTRA.categorias.forEach(function (c) { if (!CATEGORIAS.some(function (x) { return x.id === c.id; })) CATEGORIAS.push(c); });\n  var LIBROS = [');
  h = h.replace('function buscarLibro(id)', 'EXTRA.libros.forEach(function (x) { var b = null; for (var i = 0; i < LIBROS.length; i++) if (LIBROS[i].id === x.id) b = LIBROS[i]; if (b) { b.total = Math.max(b.total, x.total || 0); } else LIBROS.push(x); });\n  function buscarLibro(id)');
  h = h.replace("'Audio completo · 1 h 13 min'", "('Audio completo' + (l.duracion === undefined ? ' · 1 h 13 min' : l.duracion ? ' · ' + l.duracion : ''))");
  return h;
}

// ---------- Utilidades ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function leerJson(req, limite) {
  return new Promise((ok, mal) => {
    const trozos = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > (limite || 20000)) { mal(new Error('grande')); req.destroy(); } else trozos.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}')); } catch (e) { mal(new Error('json')); } });
    req.on('error', mal);
  });
}
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function sesionValida(req) {
  const t = String(req.headers['x-token'] || '');
  const v = sesiones.get(t);
  if (!v || v < Date.now()) { sesiones.delete(t); return false; }
  return true;
}
const slug = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const limpio = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const pad = (n) => (n < 10 ? '0' : '') + n;
const configurado = () => !!process.env.GITHUB_TOKEN;

function todasLasCategorias() { return CATS_BASE.concat(manifiesto.categorias.filter((c) => !CATS_BASE.some((b) => b.id === c.id))); }
function todosLosLibros() {
  const res = LEGACY.map((l) => Object.assign({}, l));
  manifiesto.libros.forEach((m) => { if (!res.some((l) => l.id === m.id)) res.push({ id: m.id, categoria: m.categoria, titulo: m.titulo, archivo: m.archivo, completo: !!m.completo }); });
  return res;
}

// ---------- GitHub ----------
function gh(metodo, ruta, cuerpo, extraLargo) {
  return new Promise((ok, mal) => {
    const u = new URL(GH_API + ruta);
    const lib = u.protocol === 'http:' ? require('http') : https;
    const opts = { method: metodo, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: {
      'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'User-Agent': 'la-ruta-del-bienestar', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    let datos = null;
    if (cuerpo && !extraLargo) { datos = Buffer.from(JSON.stringify(cuerpo)); opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = datos.length; }
    if (extraLargo) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = extraLargo.largo; }
    const r = lib.request(opts, (resp) => {
      const t = []; resp.on('data', (c) => t.push(c));
      resp.on('end', () => {
        const txt = Buffer.concat(t).toString('utf8'); let j = null; try { j = JSON.parse(txt); } catch (e) {}
        if (resp.statusCode >= 200 && resp.statusCode < 300) ok(j); else { const e = new Error('GitHub ' + resp.statusCode + ': ' + ((j && j.message) || txt.slice(0, 120))); e.status = resp.statusCode; mal(e); }
      });
    });
    r.setTimeout(10 * 60 * 1000, () => r.destroy(new Error('GitHub no respondió')));
    r.on('error', mal);
    if (datos) r.end(datos); else if (extraLargo) extraLargo.escribir(r); else r.end();
  });
}
// Crea el blob del mp3 mandándolo en base64 por pedazos (no carga todo en memoria).
function crearBlob(archivo, tam) {
  const largo = Math.ceil(tam / 3) * 4;
  const pre = Buffer.from('{"encoding":"base64","content":"'), post = Buffer.from('"}');
  return gh('POST', '/repos/' + REPO + '/git/blobs', null, { largo: pre.length + largo + post.length, escribir: (r) => {
    r.write(pre);
    const s = fs.createReadStream(archivo, { highWaterMark: 3 * 256 * 1024 });
    s.on('data', (c) => { if (!r.write(c.toString('base64'))) { s.pause(); r.once('drain', () => s.resume()); } });
    s.on('end', () => r.end(post)); s.on('error', (e) => r.destroy(e));
  } });
}
async function listarDir(carpeta) {
  try { const l = await gh('GET', '/repos/' + REPO + '/contents/public/audiolibros/' + carpeta + '?ref=' + BRANCH); return Array.isArray(l) ? l.map((x) => x.name) : []; }
  catch (e) { if (e.status === 404) return []; throw e; }
}
async function leerManifiestoRemoto() {
  try { const f = await gh('GET', '/repos/' + REPO + '/contents/' + MANIFEST_REL + '?ref=' + BRANCH); return JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')); }
  catch (e) { if (e.status === 404) return { categorias: [], libros: [] }; throw e; }
}

// ---------- Publicación ----------
async function publicar(s) {
  const rutaRepo = 'public/audiolibros/' + s.libroId + '/' + s.nombre;
  const blob = await crearBlob(s.archivo, s.tamano);
  s.fase = 'guardando';
  let ultimo;
  for (let intento = 0; intento < 3; intento++) {
    const ref = await gh('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH);
    const commitBase = await gh('GET', '/repos/' + REPO + '/git/commits/' + ref.object.sha);
    // Se vuelve a leer el manifiesto del repo para no pisar cambios hechos a mano
    const man = await leerManifiestoRemoto();
    man.categorias = man.categorias || []; man.libros = man.libros || [];
    if (s.catNueva && !man.categorias.some((c) => c.id === s.catNueva.id) && !CATS_BASE.some((c) => c.id === s.catNueva.id)) man.categorias.push(s.catNueva);
    let l = man.libros.find((x) => x.id === s.libroId);
    if (!l && s.libroNuevo) { l = JSON.parse(JSON.stringify(s.libroNuevo)); man.libros.push(l); }
    if (!l && !LEGACY.some((x) => x.id === s.libroId)) throw new Error('El libro no existe');
    if (!l) { l = { id: s.libroId, total: 0 }; man.libros.push(l); }
    if (s.numero) l.total = Math.max(l.total || 0, s.numero);
    if (s.duracion !== undefined && l.completo) l.duracion = s.duracion;
    const arbol = await gh('POST', '/repos/' + REPO + '/git/trees', { base_tree: commitBase.tree.sha, tree: [
      { path: rutaRepo, mode: '100644', type: 'blob', sha: blob.sha },
      { path: MANIFEST_REL, mode: '100644', type: 'blob', content: JSON.stringify(man, null, 2) + '\n' } ] });
    const commit = await gh('POST', '/repos/' + REPO + '/git/commits', { message: 'Audiolibro: ' + s.etiqueta + ' (subido desde el celu)', tree: arbol.sha, parents: [ref.object.sha] });
    try {
      await gh('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false });
      return { commit: commit.sha, rutaRepo, man };
    } catch (e) { ultimo = e; if (e.status !== 422 && e.status !== 409) throw e; }
  }
  throw ultimo || new Error('No se pudo guardar en GitHub');
}

function limpiarSubida(s) { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) {} }

async function terminar(s) {
  try {
    s.fase = 'armando';
    const destino = path.join(s.dir, 'final.mp3');
    const w = fs.createWriteStream(destino);
    for (let i = 0; i < s.partes; i++) {
      await new Promise((ok, mal) => { const r = fs.createReadStream(path.join(s.dir, 'p' + i)); r.on('error', mal); r.on('end', ok); r.pipe(w, { end: false }); });
    }
    await new Promise((ok) => w.end(ok));
    const st = fs.statSync(destino);
    if (st.size !== s.tamano) throw new Error('El archivo llegó incompleto. Probá de nuevo.');
    const cab = Buffer.alloc(3); const fd = fs.openSync(destino, 'r'); fs.readSync(fd, cab, 0, 3, 0); fs.closeSync(fd);
    if (!(cab.toString('latin1') === 'ID3' || (cab[0] === 0xff && (cab[1] & 0xe0) === 0xe0))) throw new Error('Ese archivo no parece un MP3.');
    s.archivo = destino; s.fase = 'subiendo';
    const r = await publicar(s);
    // Queda disponible ya mismo en el servidor (Render lo vuelve a armar solo desde GitHub en unos minutos)
    fs.mkdirSync(path.join(AUDIO_DIR, s.libroId), { recursive: true });
    fs.copyFileSync(destino, path.join(AUDIO_DIR, s.libroId, s.nombre));
    manifiesto = { categorias: r.man.categorias || [], libros: r.man.libros || [] };
    try { fs.mkdirSync(path.dirname(MANIFEST), { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(r.man, null, 2)); } catch (e) {}
    s.fase = 'listo'; s.ruta = '/audiolibros/' + s.libroId + '/' + s.nombre; s.libroUrl = '/audiolibros.html?libro=' + s.libroId;
  } catch (e) {
    console.error('Subida de audiolibro falló:', e.message);
    s.fase = 'error'; s.error = /GitHub 401|GitHub 403|Bad credentials/.test(e.message) ? 'GitHub no aceptó la clave (token). Revisá que esté bien pegada en Render y que no haya vencido.' : e.message;
  } finally { ocupado = false; limpiarSubida(s); }
}

// ---------- Rutas ----------
async function manejar(req, res, ruta) {
  if (ruta === '/audiolibros.html' && (req.method === 'GET' || req.method === 'HEAD')) {
    let html; try { html = fs.readFileSync(path.join(PUBLIC, 'audiolibros.html'), 'utf8'); } catch (e) { return false; }
    const out = Buffer.from(inyectar(html));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': out.length });
    res.end(req.method === 'HEAD' ? undefined : out); return true;
  }
  if (ruta === '/subir-audio.html' || ruta === '/subir-audio') {
    let h; try { h = fs.readFileSync(path.join(__dirname, 'subir-audio.html')); } catch (e) { return false; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(h); return true;
  }
  if (ruta.indexOf('/api/audio/') !== 0) return false;
  try {
    if (ruta === '/api/audio/login' && req.method === 'POST') {
      const ip = ipDe(req); const f = fallos.get(ip);
      if (f && f.n >= 5 && f.hasta > Date.now()) return json(res, 429, { ok: false, error: 'Demasiados intentos. Esperá 15 minutos.' }), true;
      const b = await leerJson(req);
      const pin = String(b.pin || '').trim();
      if (!/^\d{6,12}$/.test(pin)) return json(res, 400, { ok: false, error: 'PIN inválido' }), true;
      let j;
      try {
        const r = await fetch(APPS_SCRIPT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ accion: 'entrar', pin }), signal: AbortSignal.timeout(30000) });
        j = await r.json();
      } catch (e) { return json(res, 503, { ok: false, error: 'No se pudo verificar el PIN ahora. Probá en un minuto.' }), true; }
      if (!j || !j.ok) {
        const n = f && f.hasta > Date.now() ? f.n + 1 : 1; fallos.set(ip, { n, hasta: Date.now() + 15 * 60 * 1000 });
        return json(res, 401, { ok: false, error: 'PIN incorrecto' }), true;
      }
      fallos.delete(ip);
      const token = crypto.randomBytes(24).toString('hex'); sesiones.set(token, Date.now() + SESION_MS);
      return json(res, 200, { ok: true, token, nombre: j.nombre || '' }), true;
    }
    if (!sesionValida(req)) return json(res, 401, { ok: false, error: 'Sesión vencida' }), true;

    if (ruta === '/api/audio/estado' && req.method === 'GET') {
      return json(res, 200, { ok: true, configurado: configurado(), maxMB: Math.floor(MAX_BYTES / 1048576), parteBytes: PARTE, categorias: todasLasCategorias(), libros: todosLosLibros() }), true;
    }
    if (!configurado()) return json(res, 503, { ok: false, error: 'Falta la clave de GitHub en Render (GITHUB_TOKEN).' }), true;

    if (ruta === '/api/audio/iniciar' && req.method === 'POST') {
      if (ocupado && actual && actual.fase === 'recibiendo' && Date.now() - actual.ultima > 10 * 60 * 1000) { actual.fase = 'error'; actual.error = 'Se abandonó la subida.'; limpiarSubida(actual); ocupado = false; }
      if (ocupado) return json(res, 409, { ok: false, error: 'Ya hay una subida en curso. Esperá que termine.' }), true;
      const b = await leerJson(req);
      const tamano = parseInt(b.tamano, 10);
      if (!(tamano > 1024) || tamano > MAX_BYTES) return json(res, 400, { ok: false, error: 'El archivo tiene que pesar menos de ' + Math.floor(MAX_BYTES / 1048576) + ' MB.' }), true;
      if (!/\.mp3$/i.test(String(b.nombreArchivo || ''))) return json(res, 400, { ok: false, error: 'Solo se aceptan archivos .mp3' }), true;
      const s = { tamano, partes: Math.ceil(tamano / PARTE), recibidas: new Set(), fase: 'recibiendo', creada: Date.now() };
      let libroId = limpio(b.libro, 60);
      const existente = libroId ? todosLosLibros().find((l) => l.id === libroId) : null;
      let catNueva = null;
      if (existente) {
        s.libroId = existente.id; s.etiqueta = existente.titulo;
        s.completo = existente.completo; s.archivoPre = existente.archivo;
      } else {
        const titulo = limpio(b.titulo, 80); if (titulo.length < 2) return json(res, 400, { ok: false, error: 'Falta el título del libro.' }), true;
        let cat = limpio(b.categoria, 40);
        if (cat === '__nueva') {
          const nom = limpio(b.categoriaNueva, 30); const cid = slug(nom);
          if (nom.length < 2 || !cid) return json(res, 400, { ok: false, error: 'Falta el nombre de la categoría nueva.' }), true;
          const ya = todasLasCategorias().find((c) => c.id === cid); cat = cid;
          if (!ya) catNueva = { id: cid, nombre: nom, icono: '📚' };
        } else if (!todasLasCategorias().some((c) => c.id === cat)) return json(res, 400, { ok: false, error: 'Categoría inválida.' }), true;
        let id = slug(titulo) || 'libro'; const usados = todosLosLibros().map((l) => l.id); let k = 2; const base = id;
        while (usados.indexOf(id) !== -1) id = base + '-' + (k++);
        const completo = b.tipo === 'completo';
        s.libroId = id; s.etiqueta = titulo; s.completo = completo; s.catNueva = catNueva; s.archivoPre = completo ? 'audio-' : 'capitulo-';
        s.libroNuevo = {
          id, categoria: cat, icono: '🎧', titulo, autor: limpio(b.autor, 60),
          total: 1, base: '/audiolibros/' + id + '/', unidad: completo ? 'Audio' : 'Capítulo', unidades: completo ? 'audios' : 'capítulos',
          archivo: s.archivoPre, nota: completo ? 'Audio completo. 🌿' : 'Se suman capítulos de a poco. 🌿'
        };
        if (completo) s.libroNuevo.completo = true;
      }
      // Número de archivo
      let numero = parseInt(b.numero, 10);
      if (s.completo) numero = 1;
      const nombres = await listarDir(s.libroId);
      if (!(numero >= 1 && numero <= 999)) {
        let max = 0; nombres.forEach((n) => { const m = new RegExp('^' + s.archivoPre + '(\\d+)\\.mp3$').exec(n); if (m) max = Math.max(max, parseInt(m[1], 10)); });
        numero = max + 1;
      }
      s.numero = numero; s.nombre = s.archivoPre + pad(numero) + '.mp3';
      if (nombres.indexOf(s.nombre) !== -1) return json(res, 409, { ok: false, error: 'Ya existe ' + s.nombre + ' en ese libro. Elegí otro número.' }), true;
      if (b.total && s.libroNuevo && !s.completo) s.libroNuevo.total = Math.min(999, Math.max(1, parseInt(b.total, 10) || 1));
      if (s.libroNuevo && s.libroNuevo.total < numero) s.libroNuevo.total = numero;
      if (s.completo && b.duracion !== undefined) s.duracion = limpio(b.duracion, 20);
      s.id = crypto.randomBytes(8).toString('hex'); s.dir = path.join(TMP, s.id);
      fs.mkdirSync(s.dir, { recursive: true });
      subidas.set(s.id, s); ocupado = true; actual = s; s.ultima = Date.now();
      return json(res, 200, { ok: true, id: s.id, partes: s.partes, parteBytes: PARTE, nombre: s.nombre, libro: s.libroId, ruta: s.libroNuevo ? 'libro nuevo' : 'libro existente' }), true;
    }
    if (ruta === '/api/audio/parte' && req.method === 'PUT') {
      const u = new URL(req.url, 'http://x'); const s = subidas.get(u.searchParams.get('id')); const n = parseInt(u.searchParams.get('n'), 10);
      if (!s || s.fase !== 'recibiendo' || !(n >= 0 && n < s.partes)) return json(res, 400, { ok: false, error: 'Subida inválida' }), true;
      const esperado = n === s.partes - 1 ? s.tamano - PARTE * (s.partes - 1) : PARTE;
      await new Promise((ok, mal) => {
        const destino = path.join(s.dir, 'p' + n + '.tmp'); const w = fs.createWriteStream(destino); let c = 0;
        req.on('data', (d) => { c += d.length; if (c > MAX_PARTE) { req.destroy(); w.destroy(); mal(new Error('Pedazo demasiado grande')); } });
        req.pipe(w); w.on('finish', () => { if (c !== esperado) { fs.rmSync(destino, { force: true }); return mal(new Error('Pedazo incompleto')); } fs.renameSync(destino, path.join(s.dir, 'p' + n)); s.recibidas.add(n); s.ultima = Date.now(); ok(); });
        w.on('error', mal); req.on('error', mal);
      });
      return json(res, 200, { ok: true, recibidas: s.recibidas.size }), true;
    }
    if (ruta === '/api/audio/terminar' && req.method === 'POST') {
      const b = await leerJson(req); const s = subidas.get(String(b.id || ''));
      if (!s || s.fase !== 'recibiendo') return json(res, 400, { ok: false, error: 'Subida inválida' }), true;
      if (s.recibidas.size !== s.partes) return json(res, 400, { ok: false, error: 'Faltan pedazos', recibidas: s.recibidas.size, partes: s.partes }), true;
      s.fase = 'armando'; terminar(s);
      return json(res, 200, { ok: true }), true;
    }
    if (ruta === '/api/audio/progreso' && req.method === 'GET') {
      const s = subidas.get(new URL(req.url, 'http://x').searchParams.get('id'));
      if (!s) return json(res, 404, { ok: false, error: 'No existe' }), true;
      return json(res, 200, { ok: true, fase: s.fase, error: s.error, ruta: s.ruta, libroUrl: s.libroUrl, nombre: s.nombre, recibidas: s.recibidas.size, partes: s.partes }), true;
    }
    return json(res, 404, { ok: false, error: 'No existe' }), true;
  } catch (e) {
    console.error('API audio:', e.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message === 'grande' ? 'Pedido demasiado grande' : 'Error: ' + e.message });
    return true;
  }
}

module.exports = { manejar, inyectar };
