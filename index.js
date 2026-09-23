const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATOS = path.join(__dirname, 'productos.json');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  const ruta = decodeURIComponent(req.url.split('?')[0]);

  if (ruta === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  // Se lee en cada visita: si editás productos.json, se actualiza solo
  if (ruta === '/api/productos') {
    fs.readFile(DATOS, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('No se pudo leer productos.json');
      }
      res.writeHead(200, { 'Content-Type': TIPOS['.json'] });
      res.end(data);
    });
    return;
  }

  let archivo = path.join(PUBLIC, ruta === '/' ? 'index.html' : ruta);
  if (!archivo.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }

  // Si index.html quedó al lado de index.js (sin carpeta public), lo usa igual
  if (ruta === '/' && !fs.existsSync(archivo)) {
    archivo = path.join(__dirname, 'index.html');
  }

  fs.readFile(archivo, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontró index.html. Buscado en: ' + archivo);
    }
    const tipo = TIPOS[path.extname(archivo)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': tipo });
    res.end(data);
  });
}).listen(PORT, () => console.log('La ruta del bienestar en puerto ' + PORT));
