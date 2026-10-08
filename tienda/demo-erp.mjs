// AHORA Connect simulado para el modo demo (sin ERP real).
// Responde con la misma forma que la API real, pero con datos de ejemplo en memoria.
// No forma parte de la integración: en tu proyecto no lo necesitas.

import http from 'node:http';

const articulos = [
  ['CAM-001', 'Camiseta algodón orgánico', 'TEX', 'Textil'],
  ['SUD-020', 'Sudadera con capucha', 'TEX', 'Textil'],
  ['GOR-005', 'Gorra bordada', 'ACC', 'Accesorios'],
  ['MOC-200', 'Mochila urbana 20 L', 'ACC', 'Accesorios'],
  ['TAZ-010', 'Taza cerámica 350 ml', 'HOG', 'Hogar'],
  ['BOT-050', 'Botella térmica 500 ml', 'HOG', 'Hogar'],
  ['LIB-100', 'Libreta tapa dura A5', 'PAP', 'Papelería'],
  ['BOL-030', 'Pack bolígrafos x5', 'PAP', 'Papelería'],
].map(([IdArticulo, Descrip, IdFamilia, fam]) => ({
  IdArticulo, Descrip, Estado: 0, IdFamilia, IdIva: 0, Lotes: false, NSeries: false,
  IdDefProd: IdArticulo === 'SUD-020' ? 'TALLASCOLOR' : null, IdDefProd_flxtext: 'TALLAS Y COLORES',
  Estado_flxtext: 'Activo', IdFamilia_flxtext: fam, IdIva_flxtext: 'IVA 21% - GENERAL',
}));

let nCliente = 500, nPedido = 1000, nAlbaran = 700, nFactura = 300, nContacto = 50;
const contactos = [{ IdContacto: 1, IdCliente: '00001', Nombre: 'Principal' }, { IdContacto: 2, IdCliente: '00002', Nombre: 'Principal' }];
const clientes = [{ IdCliente: '00001', Cliente: 'Comercial Mediterráneo S.L.', Bloqueado: false }, { IdCliente: '00002', Cliente: 'Moda Norte S.A.', Bloqueado: false }];
const pedidos = {}, facturas = [];
const props = (o) => ({ Properties: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { Value: v, Text: String(v ?? ''), Label: k }])) });

function responder(method, path, body) {
  const url = new URL(path, 'http://x');
  const where = url.searchParams.get('filter') ?? '';
  const valor = (campo) => where.match(new RegExp(`${campo}\\s*=\\s*'?([^' ]+)`))?.[1];

  if (method === 'POST' && path === '/token') return [200, { access_token: 'demo', token_type: 'bearer', expires_in: 86400 }];
  if (method === 'GET' && url.pathname === '/webapi/list/ACO_Articulo') return [200, articulos];
  if (method === 'GET' && url.pathname === '/webapi/list/ACO_Cliente') return [200, clientes];
  if (method === 'GET' && url.pathname === '/webapi/list/ACO_Articulo_DefinicionProd')
    return [200, [{ IdDefProd: 'TALLASCOLOR', Orden: 1, Etiqueta: 'Talla', PropiedadStock: 'P2' },
                  { IdDefProd: 'TALLASCOLOR', Orden: 2, Etiqueta: 'Color', PropiedadStock: 'P1' }]];
  if (method === 'GET' && url.pathname === '/webapi/list/ACO_Articulo_Propiedad')
    return [200, ['S', 'M', 'L', 'XL'].flatMap((P2) => ['Negro', 'Gris', 'Azul'].map((P1) => ({ IdArticulo: valor('IdArticulo'), P1, P2 })))];
  if (method === 'GET' && url.pathname === '/webapi/list/ACO_Contacto_Facturacion')
    return [200, contactos.filter((c) => c.IdCliente === valor('IdCliente'))];
  if (method === 'GET' && url.pathname === '/webapi/list/ACO_Factura_Venta_Cliente')
    return [200, facturas.filter((f) => f.IdCliente === valor('IdCliente'))];

  if (method === 'POST' && url.pathname === '/webapi/object/ACO_Cliente') {
    if (!body.Nif) return [500, 'Debe informar del NIF del cliente'];
    const IdCliente = String(++nCliente).padStart(5, '0');
    clientes.push({ IdCliente, Cliente: body.Cliente, Bloqueado: false });
    return [200, props({ ...body, IdCliente })];
  }
  if (method === 'POST' && url.pathname === '/webapi/object/ACO_Contacto_Facturacion') {
    if (!body.Nombre) return [500, 'Debe  introducir el nombre del contacto '];
    const c = { ...body, IdContacto: ++nContacto };
    contactos.push(c);
    return [200, props(c)];
  }
  if (method === 'POST' && url.pathname === '/webapi/object/ACO_Pedido_Cliente') {
    if (!contactos.some((c) => c.IdCliente === body.IdCliente)) return [500, 'El cliente indicado no existe'];
    const IdPedido = ++nPedido;
    pedidos[IdPedido] = { ...body, IdPedido, lineas: [] };
    return [200, props({ ...body, IdPedido, NumPedido: IdPedido - 1000, IdEstado: 0 })];
  }
  if (method === 'POST' && url.pathname === '/webapi/object/ACO_Pedido_Cliente_Linea') {
    const p = pedidos[body.IdPedido];
    if (!p) return [500, 'El pedido indicado no existe'];
    if (body.IdIva == null) return [500, 'Debe introducir el IVA'];
    if (body.IdArticulo === 'SUD-020' && !body.P1 && !body.P2) return [500, 'El artículo indicado tiene definición de producto y no se han especificado'];
    p.lineas.push(body);
    return [200, props({ ...body, IdLinea: p.lineas.length })];
  }
  if (method === 'POST' && url.pathname === '/webapi/exec/pACO_Pedidos_Cliente_Lineas_MarcarFactura/ACO_Pedido_Cliente_Linea') {
    const p = pedidos[valor('IdPedido')];
    if (!p?.actualizado) return [500, 'No credentials to run pACO_Pedidos_Cliente_Lineas_MarcarFactura process'];
    p.marcadas = (p.marcadas ?? 0) + 1;
    return [200, { Success: true }];
  }
  const exec = url.pathname.match(/^\/webapi\/exec\/(\w+)\/ACO_Pedido_Cliente\/(\d+)$/);
  if (method === 'POST' && exec) {
    const p = pedidos[exec[2]];
    if (!p) return [500, 'El pedido indicado no existe'];
    if (exec[1] === 'pACO_Pedidos_Cliente_Albaranear') {
      if (p.IdAlbaran) return [500, 'El pedido no tiene líneas pendientes de albaranar'];
      p.IdAlbaran = ++nAlbaran;
      return [200, { Success: true, Message: `Albarán ${p.IdAlbaran} generado` }];
    }
    if (exec[1] === 'pACO_Pedidos_Cliente_Albaranes_Actualizar') {
      if (!p.IdAlbaran || p.actualizado) return [500, 'No credentials to run pACO_Pedidos_Cliente_Albaranes_Actualizar process'];
      p.actualizado = true;
      return [200, { Success: true }];
    }
    if (exec[1] === 'pACO_Pedidos_Cliente_Facturar') {
      if (p.marcadas !== p.lineas.length) return [500, 'No credentials to run pACO_Pedidos_Cliente_Facturar process'];   // como el real: SQLEnabled
      if (p.IdFactura) return [500, 'El pedido ya está facturado'];
      p.IdFactura = ++nFactura;
      const base = p.lineas.reduce((s, l) => s + l.Cantidad * l.Precio_EURO, 0);
      facturas.push({ IdFactura: p.IdFactura, IdCliente: p.IdCliente, NumFactCliente: `N-${p.IdFactura}`,
        FechaFact: new Date().toISOString().slice(0, 10), Base: +base.toFixed(2), Total: +(base * 1.21).toFixed(2),
        IdEstado_flxtext: 'Emitida' });
      return [200, { Success: true, Message: `Factura N-${p.IdFactura} generada` }];
    }
  }
  return [404, 'No encontrado'];
}

// Arranca en un puerto libre y devuelve su URL base
export function start() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let s = '';
      for await (const chunk of req) s += chunk;
      let body = {};
      try { body = JSON.parse(s || '{}'); } catch { /* token: form-urlencoded */ }
      const [status, data] = responder(req.method, req.url, body);
      setTimeout(() => {                       // latencia simulada, para que se vea el flujo
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      }, 250);
    });
    srv.listen(0, () => resolve(`http://localhost:${srv.address().port}`));
  });
}
