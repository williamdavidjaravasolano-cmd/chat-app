const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Aumentamos el tamano maximo de mensaje para poder enviar imagenes (5 MB), y
// hacemos que las conexiones sean mas tolerantes a pestañas en segundo plano o
// con poca actividad (los navegadores frenan los temporizadores de las pestañas
// que no estan a la vista, lo que puede hacer que un tecnico "desaparezca" sin
// haberse desconectado de verdad).
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 60000
});

// Evitamos que el navegador (o la app de escritorio) guarden en cache las
// paginas principales, para que siempre se vea la version mas reciente
// despues de cada actualizacion, sin depender de que el usuario fuerce un
// refresco manual.
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- API del Dashboard de tickets (herramienta separada del chat) ----------
// Las contraseñas de los tecnicos ahora viven en la base de datos (coleccion Tecnico),
// no en el codigo, para que los cambios de contraseña sobrevivan a futuros despliegues.
const CLAVE_GENERICA_INICIAL = 'CambioObligatorio2026';

const tecnicoSchema = new mongoose.Schema({
  nombre: { type: String, required: true, unique: true },
  clave: { type: String, required: true },
  claveCambiada: { type: Boolean, default: false } // false = todavia usa la clave generica
});
const Tecnico = mongoose.model('Tecnico', tecnicoSchema);

async function verificarCredencialesDashboard(req, res, next) {
  const usuario = req.headers['x-dashboard-usuario'];
  const clave = req.headers['x-dashboard-clave'];
  try {
    const tecnico = usuario ? await Tecnico.findOne({ nombre: usuario }) : null;
    if (!tecnico || tecnico.clave !== clave) {
      return res.status(401).json({ error: 'Usuario o clave incorrectos' });
    }
    req.tecnicoDashboard = usuario;
    next();
  } catch (err) {
    console.error('Error verificando credenciales del dashboard:', err.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------- Conexion a MongoDB Atlas ----------
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ADVERTENCIA: no se definio la variable MONGODB_URI. El historial no se va a guardar.');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Conectado a MongoDB Atlas correctamente'))
    .catch((err) => console.error('Error conectando a MongoDB:', err.message));
}

// ---------- Modelo de mensaje ----------
const mensajeSchema = new mongoose.Schema({
  sala: { type: String, required: true },
  nombre: { type: String, required: true },
  texto: { type: String, required: true },
  tipo: { type: String, default: 'texto' }, // 'texto' o 'imagen'
  hora: String,
  // TTL nativo de MongoDB: cada mensaje se autodestruye solo, 24 horas despues de su
  // propia fecha de creacion (chat general y conversaciones privadas de tickets, ambas
  // usan esta misma coleccion, asi que las dos quedan cubiertas). Reemplaza la limpieza
  // manual que haciamos antes con un setInterval en el servidor.
  fecha: { type: Date, default: Date.now, expires: 86400 },
  esRespuestaFaq: { type: Boolean, default: false }, // true si es respuesta automatica de una pregunta frecuente
  esRespuestaIA: { type: Boolean, default: false }, // true si la respondio la IA (Groq), no las palabras clave
  preguntaOrigen: { type: String, default: null }, // la pregunta que genero esta respuesta
  numeroTicket: { type: String, default: null } // el ticket relacionado con esta respuesta, si aplica
});
mensajeSchema.index({ sala: 1, fecha: 1 }); // acelera cargar el historial de una sala ordenado por fecha
const Mensaje = mongoose.model('Mensaje', mensajeSchema);

// Nota: la limpieza del historial del chat cada 24h ahora la hace MongoDB directamente
// (ver el TTL nativo en el campo "fecha" del mensajeSchema, arriba). Ya no hace falta
// este codigo revisando manualmente cada cierto tiempo.



// ---------- Modelo de votos de la encuesta de satisfaccion ----------
const votoSchema = new mongoose.Schema({
  sala: String,
  pregunta: String,
  voto: String, // 'positivo' o 'negativo'
  nombre: String,
  fecha: { type: Date, default: Date.now }
});
const Voto = mongoose.model('Voto', votoSchema);

// ---------- Modelo de tickets (Fase 1 - Sistema de tickets) ----------
const ticketSchema = new mongoose.Schema({
  numero: { type: String, unique: true },
  categoria: String,
  descripcion: String,
  prioridad: { type: String, default: 'Media' }, // Baja, Media, Alta, Urgente
  tipoServicio: { type: String, default: 'Incidente' }, // Incidente o Requerimiento (define el tiempo de atencion oficial)
  imagenAdjunta: { type: String, default: null }, // captura de pantalla en base64 (opcional)
  nombre: String, // quien creo el ticket
  area: { type: String, default: '' },
  cargo: { type: String, default: '' },
  extension: { type: String, default: '' },
  sala: String,
  estado: { type: String, default: 'Creado' }, // Creado, En proceso, En espera, Resuelto
  solucion: { type: String, default: null },
  tecnicoAsignado: { type: String, default: null }, // quien tomo el caso con /tomar
  aprobadoParaConocimiento: { type: Boolean, default: false },
  calificacion: { type: Number, default: null }, // 1 a 5, la pone el usuario cuando el ticket queda Resuelto
  comentarioCalificacion: { type: String, default: null },
  historial: [{ estado: String, fecha: { type: Date, default: Date.now } }],
  fechaCreacion: { type: Date, default: Date.now },
  alertaSlaEnviada: { type: Boolean, default: false } // evita repetir la alerta de "por vencer" varias veces
});
ticketSchema.index({ nombre: 1 }); // acelera "Mis tickets" (busca por quien lo creo)
ticketSchema.index({ tecnicoAsignado: 1, estado: 1 }); // acelera el Panel tecnico y el Dashboard
ticketSchema.index({ estado: 1, fechaCreacion: 1 }); // acelera la asignacion automatica y los reportes
const Ticket = mongoose.model('Ticket', ticketSchema);

async function generarNumeroTicket() {
  const total = await Ticket.countDocuments();
  return `T-${4580 + total + 1}`;
}

// Registro de quien entra al dashboard y cuando (para trazabilidad)
const accesoDashboardSchema = new mongoose.Schema({
  tecnico: String,
  fecha: { type: Date, default: Date.now }
});
const AccesoDashboard = mongoose.model('AccesoDashboard', accesoDashboardSchema);

// El dashboard llama esto una vez, al iniciar sesion, para validar y dejar registro
app.post('/api/dashboard-login', async (req, res) => {
  const { usuario, clave } = req.body || {};
  try {
    const tecnico = usuario ? await Tecnico.findOne({ nombre: usuario }) : null;
    if (!tecnico || tecnico.clave !== clave) {
      return res.status(401).json({ error: 'Usuario o clave incorrectos' });
    }
    try {
      await new AccesoDashboard({ tecnico: usuario }).save();
    } catch (err) {
      console.error('Error registrando acceso al dashboard:', err.message);
    }
    res.json({ ok: true, tecnico: usuario, debeCambiarClave: !tecnico.claveCambiada });
  } catch (err) {
    console.error('Error en /api/dashboard-login:', err.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Permite a un tecnico cambiar su propia contraseña (desde el dashboard o desde el chat)
app.post('/api/cambiar-clave-tecnico', async (req, res) => {
  const { usuario, claveActual, claveNueva } = req.body || {};
  if (!usuario || !claveActual || !claveNueva) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  if (claveNueva.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const tecnico = await Tecnico.findOne({ nombre: usuario });
    if (!tecnico || tecnico.clave !== claveActual) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }
    tecnico.clave = claveNueva;
    tecnico.claveCambiada = true;
    await tecnico.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error cambiando la clave del tecnico:', err.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Devuelve todos los tickets (para el dashboard). Admite filtros opcionales por
// query string: ?estado=Resuelto&tecnico=William%20David
app.get('/api/tickets', verificarCredencialesDashboard, async (req, res) => {
  try {
    const filtro = {};
    if (req.query.estado) filtro.estado = req.query.estado;
    if (req.query.tecnico) filtro.tecnicoAsignado = req.query.tecnico;

    const tickets = await Ticket.find(filtro).sort({ fechaCreacion: -1 });
    res.json(tickets);
  } catch (err) {
    console.error('Error en /api/tickets:', err.message);
    res.status(500).json({ error: 'Error obteniendo los tickets' });
  }
});

// Busqueda de texto avanzada usando el indice de Atlas Search "busqueda_tickets"
// (entiende variaciones de palabras, no solo coincidencia exacta como el buscador anterior)
app.get('/api/tickets/buscar', verificarCredencialesDashboard, async (req, res) => {
  const termino = (req.query.q || '').trim();
  if (!termino) return res.json([]);
  try {
    const resultados = await Ticket.aggregate([
      {
        $search: {
          index: 'busqueda_tickets',
          text: {
            query: termino,
            path: { wildcard: '*' }
          }
        }
      },
      { $limit: 50 }
    ]);
    res.json(resultados);
  } catch (err) {
    console.error('Error en la busqueda avanzada de tickets:', err.message);
    res.status(500).json({ error: 'Error en la búsqueda avanzada' });
  }
});

// Tomar un caso desde el dashboard
app.post('/api/tickets/:numero/tomar', verificarCredencialesDashboard, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ numero: req.params.numero });
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    if (ticket.estado === 'Resuelto') return res.status(400).json({ error: 'El ticket ya está resuelto' });

    ticket.estado = 'En proceso';
    ticket.tecnicoAsignado = req.tecnicoDashboard;
    ticket.historial.push({ estado: 'En proceso' });
    await ticket.save();

    const mensajeTomado = {
      sala: SALA_SOPORTE,
      nombre: NOMBRE_BOT_SOPORTE,
      texto: `🧑‍💻 ${req.tecnicoDashboard} tomó el ticket #${ticket.numero} (desde el dashboard) y está trabajando en tu caso, ${ticket.nombre}.`,
      tipo: 'texto',
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
    };
    await new Mensaje(mensajeTomado).save();
    io.to(SALA_SOPORTE).emit('mensaje', mensajeTomado);

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('Error tomando ticket desde el dashboard:', err.message);
    res.status(500).json({ error: 'Error tomando el ticket' });
  }
});

// Resolver un caso desde el dashboard
app.post('/api/tickets/:numero/resolver', verificarCredencialesDashboard, async (req, res) => {
  const { solucion } = req.body || {};
  if (!solucion || !solucion.trim()) return res.status(400).json({ error: 'Falta la solución' });

  try {
    const ticket = await Ticket.findOne({ numero: req.params.numero });
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

    ticket.estado = 'Resuelto';
    ticket.solucion = solucion.trim();
    if (!ticket.tecnicoAsignado) ticket.tecnicoAsignado = req.tecnicoDashboard;
    ticket.historial.push({ estado: 'Resuelto' });
    await ticket.save();

    const mensajeConfirmacion = {
      sala: SALA_SOPORTE,
      nombre: NOMBRE_BOT_SOPORTE,
      texto: `✅ ${req.tecnicoDashboard} marcó el ticket #${ticket.numero} como resuelto (desde el dashboard).\n\nSolución: ${ticket.solucion}`,
      tipo: 'texto',
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
    };
    await new Mensaje(mensajeConfirmacion).save();
    io.to(SALA_SOPORTE).emit('mensaje', mensajeConfirmacion);

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('Error resolviendo ticket desde el dashboard:', err.message);
    res.status(500).json({ error: 'Error resolviendo el ticket' });
  }
});

// Aprobar la solucion de un ticket resuelto para la base de conocimiento, desde el dashboard
app.post('/api/tickets/:numero/aprobar', verificarCredencialesDashboard, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ numero: req.params.numero });
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    if (ticket.estado !== 'Resuelto' || !ticket.solucion) {
      return res.status(400).json({ error: 'El ticket todavía no tiene una solución registrada' });
    }
    if (ticket.aprobadoParaConocimiento) {
      return res.status(400).json({ error: 'Esta solución ya había sido aprobada' });
    }

    ticket.aprobadoParaConocimiento = true;
    await ticket.save();

    const textoDescripcion = normalizarTexto(ticket.descripcion);
    const palabrasClave = Array.from(new Set(
      [textoDescripcion, ...textoDescripcion.split(' ').filter((palabra) => palabra.length > 3)]
    ));
    preguntasFrecuentes.push({ pregunta: ticket.descripcion, palabrasClave, respuesta: ticket.solucion });

    await new Conocimiento({
      sala: SALA_SOPORTE,
      pregunta: ticket.descripcion,
      palabrasClave,
      respuesta: ticket.solucion,
      ticketOrigen: ticket.numero
    }).save();

    const mensajeAprobado = {
      sala: SALA_SOPORTE,
      nombre: NOMBRE_BOT_SOPORTE,
      texto: `🧠 ${req.tecnicoDashboard} aprobó (desde el dashboard) la solución del ticket #${ticket.numero}. A partir de ahora se usará automáticamente para casos parecidos.`,
      tipo: 'texto',
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
    };
    await new Mensaje(mensajeAprobado).save();
    io.to(SALA_SOPORTE).emit('mensaje', mensajeAprobado);

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('Error aprobando ticket desde el dashboard:', err.message);
    res.status(500).json({ error: 'Error aprobando el ticket' });
  }
});

// Arma el bloque de datos del ticket en el formato que se muestra en el chat
function formatoDatosTicket({ area, nombre, cargo, extension, incidencia }) {
  return `Área: ${area || 'N/A'}\nNombre: ${nombre}\nCargo: ${cargo || 'N/A'}\nExt: ${extension || 'N/A'}\nIncidencia: ${incidencia}`;
}

// ---------- Tecnicos autorizados ----------
// Este es el valor inicial (por si la base de datos esta vacia la primera vez).
// A partir de que el servidor arranca, esta lista se sincroniza con la coleccion
// "Tecnico" de la base de datos, y se puede administrar sin tocar el codigo desde
// el panel "Administrar tecnicos" (menu ☰, solo Hector y William David).
let TECNICOS_AUTORIZADOS = ['Juan Diego', 'Juan Pablo', 'Juan Jose', 'Yin Carlos', 'William David', 'Henrry', 'Hector', 'Kevin Daniel'];

// Recarga TECNICOS_AUTORIZADOS desde la base de datos. Usamos splice (no una
// reasignacion) para que el mismo arreglo en memoria se actualice, y todo el
// codigo que ya lo referencia (TECNICOS_AUTORIZADOS.some/.find/.filter, etc.)
// vea siempre la version mas reciente sin necesidad de cambiar cada referencia.
async function sincronizarListaTecnicos() {
  try {
    const registros = await Tecnico.find({}).sort({ nombre: 1 });
    const nombres = registros.map((r) => r.nombre);
    TECNICOS_AUTORIZADOS.splice(0, TECNICOS_AUTORIZADOS.length, ...nombres);
  } catch (err) {
    console.error('Error sincronizando la lista de tecnicos:', err.message);
  }
}

function esTecnicoAutorizado(nombre) {
  const normalizado = normalizarTexto(nombre || '');
  return TECNICOS_AUTORIZADOS.some((tecnico) => normalizarTexto(tecnico) === normalizado);
}

// Solo estos dos pueden ver el panel de Reportes (aunque sean tecnicos autorizados)
const AUTORIZADOS_REPORTES = ['Hector', 'William David'];
function puedeVerReportes(nombre) {
  const normalizado = normalizarTexto(nombre || '');
  return AUTORIZADOS_REPORTES.some((autorizado) => normalizarTexto(autorizado) === normalizado);
}

// Revisa el estado real de los 3 servicios. Reutilizada por /api/estado y por
// la revision periodica que envia alertas por correo.
async function obtenerEstadoCompleto() {
  const baseDatosOperativa = mongoose.connection.readyState === 1;

  // Revisamos la IA en vivo solo si no se ha probado en los ultimos 5 minutos,
  // para no gastar cuota de la API en cada revision.
  const cincoMinutos = 5 * 60 * 1000;
  const necesitaRevisionIA = !estadoIA.fecha || (Date.now() - estadoIA.fecha.getTime()) > cincoMinutos;

  if (!GROQ_API_KEY) {
    estadoIA = { operativo: false, fecha: new Date() };
  } else if (necesitaRevisionIA) {
    try {
      const respuestaPrueba = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(8000)
      });
      estadoIA = { operativo: respuestaPrueba.ok, fecha: new Date() };
    } catch (err) {
      estadoIA = { operativo: false, fecha: new Date() };
    }
  }

  return { chat: true, baseDatos: baseDatosOperativa, ia: estadoIA.operativo, ultimaRevisionIA: estadoIA.fecha };
}

// Estado del sistema (publico, sin necesidad de iniciar sesion) - usado por /estado.html
app.get('/api/estado', async (req, res) => {
  const estado = await obtenerEstadoCompleto();
  res.json(estado);
});

// Devuelve la lista completa de tecnicos autorizados, la tengan o no asignados ya
app.get('/api/tecnicos', verificarCredencialesDashboard, (req, res) => {
  res.json(TECNICOS_AUTORIZADOS);
});

// Devuelve solo los tecnicos que estan conectados al chat en este momento
app.get('/api/tecnicos-en-linea', verificarCredencialesDashboard, (req, res) => {
  const conectados = Object.values(usuariosPorSala[SALA_SOPORTE] || {});
  const tecnicosEnLinea = TECNICOS_AUTORIZADOS.filter((tecnico) =>
    conectados.some((nombreConectado) => normalizarTexto(nombreConectado) === normalizarTexto(tecnico))
  );
  res.json(tecnicosEnLinea);
});

// Devuelve las sugerencias del buzon (para calcular calificaciones en el dashboard)
app.get('/api/sugerencias', verificarCredencialesDashboard, async (req, res) => {
  try {
    const sugerencias = await Sugerencia.find({}).sort({ fecha: -1 });
    res.json(sugerencias);
  } catch (err) {
    console.error('Error en /api/sugerencias:', err.message);
    res.status(500).json({ error: 'Error obteniendo las sugerencias' });
  }
});

// ---------- IA en la nube (Groq, gratis) ----------
// Se usa como respaldo cuando el bot no reconoce la pregunta con palabras clave.
// Funciona siempre, sin depender de que tu PC este prendido.
// GROQ_API_KEY se configura como variable de entorno en Render.
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Guarda el ultimo resultado conocido de la IA, para la pagina de estado del sistema
// (evita golpear la API de Groq en cada revision; se refresca solo cada 5 minutos)
let estadoIA = { operativo: null, fecha: null };

// ---------- Alertas por correo cuando un servicio deja de funcionar ----------
// Render bloquea las conexiones SMTP directas (por eso Gmail via nodemailer no
// funcionaba), asi que el correo se envia con Resend, un servicio que entrega
// el correo por una API normal de internet (HTTPS), gratis hasta 3000 correos/mes.
// Se configura con variables de entorno en Render:
//   RESEND_API_KEY -> la clave que te da resend.com al crear la cuenta
//   EMAIL_DESTINO   -> a quien le llega la alerta (puede ser varias, separadas por coma)
// Si estas variables no estan configuradas, esta funcion simplemente no hace nada.
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

async function enviarCorreoAlerta(asunto, mensaje) {
  if (!resend || !EMAIL_DESTINO) return;
  try {
    const destinatarios = EMAIL_DESTINO.split(',').map((correo) => correo.trim()).filter(Boolean);
    await resend.emails.send({
      from: 'Estado del Sistema <onboarding@resend.dev>',
      to: destinatarios,
      subject: asunto,
      text: mensaje
    });
    console.log('Correo de alerta enviado:', asunto);
  } catch (err) {
    console.error('Error enviando correo de alerta:', err.message);
  }
}

// Guarda el ultimo estado conocido de cada servicio, para avisar solo cuando CAMBIA
// (de operativo a caido, o de caido a recuperado), no cada vez que se revisa.
let ultimoEstadoConocido = { chat: true, baseDatos: true, ia: true };
const NOMBRES_SERVICIOS = { chat: 'el servidor', baseDatos: 'la base de datos', ia: 'la inteligencia artificial' };

async function revisarYAlertarPorCorreo() {
  if (!resend || !EMAIL_DESTINO) return; // no configurado, no hacemos nada

  const estadoActual = await obtenerEstadoCompleto();

  for (const clave of ['chat', 'baseDatos', 'ia']) {
    const antes = ultimoEstadoConocido[clave];
    const ahora = estadoActual[clave];

    if (antes !== false && ahora === false) {
      await enviarCorreoAlerta(
        `⚠️ Alerta: ${NOMBRES_SERVICIOS[clave]} no está disponible`,
        `Se detectó que ${NOMBRES_SERVICIOS[clave]} dejó de responder correctamente en el sistema de soporte técnico.\n\nFecha: ${new Date().toLocaleString('es-CO')}\n\nRevisa https://chat-app-kc6g.onrender.com/estado.html para más detalle.`
      );
    } else if (antes === false && ahora === true) {
      await enviarCorreoAlerta(
        `✅ Recuperado: ${NOMBRES_SERVICIOS[clave]} volvió a funcionar`,
        `${NOMBRES_SERVICIOS[clave]} volvió a estar operativo con normalidad.\n\nFecha: ${new Date().toLocaleString('es-CO')}`
      );
    }
  }

  ultimoEstadoConocido = { chat: estadoActual.chat, baseDatos: estadoActual.baseDatos, ia: estadoActual.ia };
}

async function preguntarIA(pregunta) {
  if (!GROQ_API_KEY) return null;
  try {
    const respuesta = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          {
            role: 'system',
            content: `Eres el asistente de soporte técnico del Hospital HGM, dentro de un chat interno de soporte técnico (no un portal web aparte). Responde en español, de forma breve y clara, usando pasos numerados cuando tenga sentido. No uses más de 6 pasos.

REGLAS IMPORTANTES:
- NUNCA inventes portales, sitios web, URLs, números de extensión, nombres de sistemas o software que no conozcas con certeza. Si no sabes el procedimiento exacto de este hospital, dilo claramente en vez de inventar uno.
- Este chat YA tiene su propio sistema de tickets integrado: si el usuario pregunta cómo reportar un problema o crear un caso, dile que use el botón "🎫 Crear ticket" en el menú ☰ de este mismo chat — nunca menciones un portal externo, correo electrónico, o sistema distinto.
- Si la pregunta es sobre un problema técnico específico (equipo, impresora, red, software) y no estás seguro de la causa exacta, da los pasos básicos y generales de diagnóstico que sean seguros de intentar, y aclara que si no se soluciona, debe crear un ticket para que un técnico humano lo revise.
- No des instrucciones que requieran permisos de administrador o acceso a sistemas internos que no conoces.`
          },
          { role: 'user', content: pregunta }
        ],
        max_tokens: 500
      }),
      signal: AbortSignal.timeout(15000) // maximo 15 segundos de espera
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      console.error(`Groq respondio con error ${respuesta.status}: ${detalle}`);
      estadoIA = { operativo: false, fecha: new Date() };
      return null;
    }
    const datos = await respuesta.json();
    estadoIA = { operativo: true, fecha: new Date() };
    return datos.choices && datos.choices[0] ? datos.choices[0].message.content.trim() : null;
  } catch (err) {
    console.error('Error consultando la IA (Groq):', err.message);
    estadoIA = { operativo: false, fecha: new Date() };
    return null;
  }
}

// Le pide a la IA que determine la prioridad de un ticket segun su descripcion,
// para que no dependa de que el usuario elija (y que todos escojan "Urgente").
// Devuelve siempre un valor valido (Baja/Media/Alta/Urgente); si la IA falla,
// usa "Media" por defecto para no bloquear la creacion del ticket.
async function clasificarPrioridadConIA(descripcion, categoria, tipoServicio) {
  const PRIORIDAD_POR_DEFECTO = 'Media';
  if (!GROQ_API_KEY) return PRIORIDAD_POR_DEFECTO;

  try {
    const respuesta = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          {
            role: 'system',
            content: `Eres un clasificador de prioridad para un sistema de soporte técnico de un hospital. Vas a recibir la categoría, el tipo de servicio, y la descripción de un caso. Responde con UNA SOLA PALABRA, exactamente una de estas cuatro: Baja, Media, Alta, Urgente. No agregues explicación ni puntuación.

Guía para clasificar:
- Urgente: la situación afecta directamente la atención de un paciente, o deja totalmente inoperativo un servicio crítico (ej: no se puede registrar una urgencia, un equipo médico conectado no funciona, toda un área sin ningún sistema).
- Alta: afecta el trabajo de forma importante pero no pone en riesgo a un paciente de forma inmediata (ej: un sistema clave lento o con errores, pero se puede seguir operando con dificultad).
- Media: una molestia que no impide seguir trabajando (ej: impresora no imprime, un programa se congela ocasionalmente).
- Baja: algo cosmético, una duda, o algo que puede esperar sin afectar el trabajo diario.

Si la descripción es ambigua o muy corta, usa Media.`
          },
          {
            role: 'user',
            content: `Categoría: ${categoria || 'N/A'}\nTipo de servicio: ${tipoServicio || 'N/A'}\nDescripción: ${descripcion}`
          }
        ],
        max_tokens: 5,
        temperature: 0
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!respuesta.ok) return PRIORIDAD_POR_DEFECTO;

    const datos = await respuesta.json();
    const texto = datos.choices && datos.choices[0] ? datos.choices[0].message.content.trim() : '';
    const limpio = texto.replace(/[^a-zA-ZÁÉÍÓÚáéíóú]/g, '');
    const opcionesValidas = ['Baja', 'Media', 'Alta', 'Urgente'];
    const encontrada = opcionesValidas.find((opcion) => normalizarTexto(opcion) === normalizarTexto(limpio));
    return encontrada || PRIORIDAD_POR_DEFECTO;
  } catch (err) {
    console.error('Error clasificando la prioridad con IA:', err.message);
    return PRIORIDAD_POR_DEFECTO;
  }
}

// Cada vez que se resuelve un ticket con el comando /resolver, se guarda aqui
// para que quede disponible aunque el servidor se reinicie.
const conocimientoSchema = new mongoose.Schema({
  sala: String,
  pregunta: String,
  palabrasClave: [String],
  respuesta: String,
  ticketOrigen: String,
  fecha: { type: Date, default: Date.now }
});
const Conocimiento = mongoose.model('Conocimiento', conocimientoSchema);

// ---------- Buzon de sugerencias y calificacion hacia un tecnico ----------
const sugerenciaSchema = new mongoose.Schema({
  nombre: { type: String, required: true }, // quien envia la sugerencia (no es anonimo)
  tecnicoCalificado: { type: String, default: null }, // opcional: a que tecnico califica
  calificacion: { type: Number, default: null }, // 1 a 5, opcional
  mensaje: { type: String, required: true },
  fecha: { type: Date, default: Date.now }
});
sugerenciaSchema.index({ tecnicoCalificado: 1 }); // acelera calcular el promedio por tecnico
const Sugerencia = mongoose.model('Sugerencia', sugerenciaSchema);

// ---------- Avisos de problemas conocidos ----------
// Un tecnico puede marcar un problema como "ya lo sabemos", con palabras clave.
// Si un usuario escribe algo que coincide, el bot avisa que ya se sabe del problema
// en vez de mandarlo a las preguntas frecuentes o a la IA (para evitar tickets
// duplicados de una misma falla masiva).
const avisoConocidoSchema = new mongoose.Schema({
  palabrasClave: [String], // ej: ['laboratorio', 'lab']
  mensaje: { type: String, required: true },
  creadoPor: String,
  activo: { type: Boolean, default: true },
  fecha: { type: Date, default: Date.now }
});
const AvisoConocido = mongoose.model('AvisoConocido', avisoConocidoSchema);

// ---------- Respuestas rapidas guardadas (plantillas) ----------
// Compartidas entre todos los tecnicos, para no escribir lo mismo una y otra vez
// en la conversacion privada con un usuario.
const plantillaRespuestaSchema = new mongoose.Schema({
  texto: { type: String, required: true },
  creadoPor: String,
  fecha: { type: Date, default: Date.now }
});
const PlantillaRespuesta = mongoose.model('PlantillaRespuesta', plantillaRespuestaSchema);

async function buscarAvisoConocido(textoNormalizado) {
  try {
    const avisos = await AvisoConocido.find({ activo: true });
    return avisos.find((aviso) =>
      aviso.palabrasClave.some((palabra) => textoNormalizado.includes(normalizarTexto(palabra)))
    ) || null;
  } catch (err) {
    console.error('Error buscando avisos de problemas conocidos:', err.message);
    return null;
  }
}

// ---------- Preguntas frecuentes por sala ----------
// Puedes agregar mas preguntas aqui. El "pregunta" debe escribirse EXACTAMENTE
// igual en el archivo public/index.html (objeto preguntasPorSala), porque es lo
// que se envia cuando alguien hace click en el boton. Las "palabrasClave" son
// para reconocer la pregunta aunque el usuario la escriba distinto -- agrega
// todas las variaciones que se te ocurran, en minusculas y sin tildes.
const NOMBRE_BOT_SOPORTE = 'Soporte Tecnico 🤖';
const SALA_SOPORTE = 'Soporte Tecnico';

const preguntasFrecuentes = [
  {
    pregunta: 'Se me apagó el equipo y no enciende',
    palabrasClave: ['no enciende', 'no prende', 'no arranca', 'se apago y no', 'pantalla negra', 'no enciende el computador', 'no enciende el equipo', 'no enciende el pc'],
    respuesta:
      '1. Desconecta el cable de energía del computador.\n' +
      '2. Mantén presionado el botón de encendido (power) durante 15 segundos para liberar la energía estática.\n' +
      '3. Vuelve a conectar el cable de energía.\n' +
      '4. Presiona el botón de encendido (power) — el equipo debería encender normalmente.\n' +
      'Si aún así no enciende, revisa que el cable y el tomacorriente funcionen probando con otro aparato.'
  },
  {
    pregunta: 'Mi computador está muy lento',
    palabrasClave: ['lento', 'lenta', 'muy lento', 'se demora', 'esta pesado', 'va lento', 'anda lento', 'trabado', 'se pega'],
    respuesta:
      '1. Cierra los programas y pestañas del navegador que no estés usando.\n' +
      '2. Reinicia el equipo por completo (no solo cerrar sesión).\n' +
      '3. Revisa cuánto espacio libre tienes en el disco duro; si está casi lleno, elimina archivos que no uses.\n' +
      '4. Ejecuta el antivirus para descartar programas maliciosos.\n' +
      'Si el problema continúa después de estos pasos, escribe aquí para que un asesor te ayude en detalle.'
  },
  {
    pregunta: 'No tengo conexión a internet o wifi',
    palabrasClave: ['no tengo internet', 'sin internet', 'no hay wifi', 'no conecta wifi', 'internet no funciona', 'sin wifi', 'no hay señal', 'no carga internet', 'no tengo wifi', 'se corto el internet'],
    respuesta:
      '1. Verifica que el cable de red esté bien conectado a tu computador, o que el wifi esté activado (icono de wifi en la barra de tareas).\n' +
      '2. Pregúntale a un compañero cercano si a él también le falla el internet; eso ayuda a saber si es solo tu equipo o toda la red.\n' +
      '3. Reinicia tu computador (cierra sesión y vuelve a iniciar), sin tocar el router ni otros equipos de red.\n' +
      'Si el problema continúa, escribe aquí indicando tu área o ubicación para que el área de sistemas revise la red desde su lado.'
  },
  {
    pregunta: 'Olvidé mi contraseña de usuario en Windows',
    palabrasClave: ['olvide mi contraseña', 'se me olvido la clave', 'no recuerdo la contraseña', 'perdi la contraseña', 'clave de windows', 'no recuerdo la clave', 'olvide la clave'],
    respuesta:
      '1. Verifica que la tecla "Bloq Mayús" (Caps Lock) no esté activada, ya que esto cambia mayúsculas y minúsculas al escribir la contraseña.\n' +
      '2. Confirma que estás escribiendo el nombre de usuario correcto (a veces hay más de un usuario creado en el mismo equipo).\n' +
      '3. Intenta con las contraseñas que uses habitualmente, por si la escribiste mal o la confundiste con otra.\n' +
      'Si aún así no logras ingresar, escribe aquí indicando tu nombre de usuario (nunca escribas tu contraseña aquí) para que el área de sistemas te restablezca el acceso, ya que ese cambio solo lo puede hacer un administrador.'
  }
];

const NOMBRE_BOT_ASESORIA = 'Asesoría Técnica 🤖';
const SALA_ASESORIA = 'Asesoria Tecnica';

const preguntasAsesoria = [
  {
    pregunta: '¿Qué computador me recomiendan comprar?',
    palabrasClave: ['que computador compro', 'que pc me recomiendan', 'cual computador comprar', 'recomiendan un computador', 'que portatil comprar', 'que laptop comprar'],
    respuesta:
      'Depende del uso que le vayas a dar:\n' +
      '- Uso basico (internet, redes sociales, documentos): un equipo con 8 GB de RAM y procesador Intel i3/i5 o AMD Ryzen 3/5 es suficiente.\n' +
      '- Trabajo mas exigente (edicion, diseño, varios programas abiertos): busca 16 GB de RAM y procesador i5/i7 o Ryzen 5/7.\n' +
      'Cuentanos tu presupuesto y para que lo vas a usar, y un asesor te da una recomendacion mas puntual.'
  },
  {
    pregunta: '¿Cómo elijo un buen plan de internet?',
    palabrasClave: ['que plan de internet', 'cual plan de internet', 'plan de internet recomendado', 'que megas necesito', 'cuantos megas necesito'],
    respuesta:
      '1. Para uso basico (redes sociales, whatsapp, correo) con 1-2 equipos: 20-50 Mbps es suficiente.\n' +
      '2. Para streaming en varios equipos o trabajo desde casa: busca 100 Mbps o mas.\n' +
      '3. Si varias personas usan internet al mismo tiempo, prioriza planes con buena velocidad de subida, no solo de bajada.\n' +
      'Cuentanos cuantas personas y equipos usan el internet en tu casa para darte una recomendacion mas exacta.'
  },
  {
    pregunta: '¿Necesito antivirus pago o el gratis es suficiente?',
    palabrasClave: ['antivirus pago', 'antivirus gratis', 'necesito antivirus', 'cual antivirus', 'que antivirus usar'],
    respuesta:
      'Para la mayoria de usuarios en casa, el antivirus gratuito que trae Windows (Windows Defender) es suficiente si:\n' +
      '1. Mantienes Windows actualizado.\n' +
      '2. No descargas programas de paginas desconocidas.\n' +
      '3. Tienes cuidado con los enlaces y archivos que llegan por correo o whatsapp.\n' +
      'Si usas el equipo para trabajo con informacion sensible, un antivirus pago puede darte proteccion adicional.'
  },
  {
    pregunta: '¿Cada cuánto debo hacerle mantenimiento a mi equipo?',
    palabrasClave: ['cada cuanto mantenimiento', 'cuando hacer mantenimiento', 'mantenimiento del equipo', 'mantenimiento del computador', 'limpieza del computador'],
    respuesta:
      'Recomendacion general:\n' +
      '1. Limpieza de polvo interno: cada 6 meses (o cada 3 si el ambiente tiene mucho polvo).\n' +
      '2. Revision de espacio en disco y archivos innecesarios: cada mes.\n' +
      '3. Actualizaciones de Windows y antivirus: dejalas automaticas.\n' +
      '4. Revision fisica completa por un tecnico: una vez al año.'
  }
];

// Busca una pregunta frecuente por coincidencia exacta primero, y si no,
// por palabras clave dentro del texto que escribio el usuario.
function buscarPreguntaFaq(lista, textoNormalizado) {
  for (const item of lista) {
    if (normalizarTexto(item.pregunta) === textoNormalizado) return item;
  }
  for (const item of lista) {
    for (const palabra of item.palabrasClave) {
      if (textoNormalizado.includes(normalizarTexto(palabra))) return item;
    }
  }
  return null;
}

// Al iniciar el servidor, cargamos las soluciones aprendidas de tickets
// resueltos anteriormente, para que sigan funcionando aunque Render reinicie.
mongoose.connection.once('open', async () => {
  // El historial del chat (mensajes) ya se autolimpia con el TTL nativo de MongoDB (24h).

  // Revisa cada minuto si hay tickets sin tomar que ya cumplieron el tiempo de espera
  setInterval(asignarTicketsAutomaticamente, 60 * 1000);

  // Revisa cada minuto si algun caso esta por vencer su tiempo oficial de atencion,
  // para avisar al tecnico asignado, o asignar de emergencia si nadie lo ha tomado.
  setInterval(revisarAlertasYAsignacionPorSla, 60 * 1000);

  // Revisa cada 5 minutos el estado de los servicios, y manda un correo si algo
  // cambia (se cae, o se recupera). Si no hay correo configurado, no hace nada.
  // Tambien revisa una vez de inmediato al arrancar, para no depender de esperar
  // 5 minutos completos despues de cada reinicio del servidor.
  revisarYAlertarPorCorreo();
  setInterval(revisarYAlertarPorCorreo, 5 * 60 * 1000);

  try {
    const aprendidos = await Conocimiento.find({});
    aprendidos.forEach((item) => {
      const nuevoItem = { pregunta: item.pregunta, palabrasClave: item.palabrasClave, respuesta: item.respuesta };
      if (item.sala === SALA_SOPORTE) preguntasFrecuentes.push(nuevoItem);
      else if (item.sala === SALA_ASESORIA) preguntasAsesoria.push(nuevoItem);
    });
    console.log(`Se cargaron ${aprendidos.length} soluciones aprendidas de tickets resueltos.`);
  } catch (err) {
    console.error('Error cargando la base de conocimiento aprendida:', err.message);
  }

  // Crea el registro de cada tecnico autorizado en la base de datos, con la clave
  // generica, SOLO si todavia no existe (para no pisar contraseñas ya personalizadas).
  try {
    for (const nombreTecnico of TECNICOS_AUTORIZADOS) {
      const existente = await Tecnico.findOne({ nombre: nombreTecnico });
      if (!existente) {
        await new Tecnico({ nombre: nombreTecnico, clave: CLAVE_GENERICA_INICIAL, claveCambiada: false }).save();
        console.log(`Tecnico creado con clave genérica: ${nombreTecnico}`);
      }
    }
  } catch (err) {
    console.error('Error creando los registros iniciales de tecnicos:', err.message);
  }

  // A partir de aqui, la base de datos es la fuente de la verdad: la lista de
  // tecnicos autorizados se toma de la coleccion Tecnico, no del arreglo fijo.
  await sincronizarListaTecnicos();
});

// ---------- Saludo automatico tipo mesa de ayuda (todas las salas) ----------
const NOMBRE_BOT_SALUDO = 'Mesa de Ayuda 🤖';
const saludos = ['hola', 'holaa', 'holaaa', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'que tal', 'ola', 'buen dia', 'saludos'];

// Frases que indican que una respuesta anterior no funciono, para escalar a un asesor
const frasesInsatisfaccion = [
  'no funciono', 'no me funciono', 'no me sirvio', 'no sirvio', 'sigue igual', 'sigue el problema',
  'no resolvio', 'no funciona', 'eso no funciono', 'no ayudo', 'no me ayudo', 'sigue sin funcionar',
  'no se soluciono', 'no quedo resuelto', 'sigo con el mismo problema', 'no paso nada',
  'sigue lento', 'sigue lenta', 'aun lento', 'aun lenta', 'aun sigue', 'todavia lento', 'todavia lenta',
  'no cambio nada', 'nada cambio', 'realice estos pasos', 'realice los pasos', 'hice estos pasos',
  'hice los pasos', 'segui los pasos', 'segui estos pasos', 'ya intente eso', 'ya lo intente',
  'sigue pasando', 'sigue fallando', 'sigue sin conexion', 'sigue sin internet'
];

function normalizarTexto(texto) {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[¿?¡!.,]/g, ''); // quita signos de puntuacion
}

// Usuarios conectados por sala: { nombreSala: { socketId: nombreUsuario } }
const usuariosPorSala = {};

// ---------- Asignacion automatica de tickets sin tomar ----------
// Si un ticket lleva 5 minutos sin que ningun tecnico lo tome, y hay al menos
// un tecnico autorizado conectado al chat en ese momento, se le asigna solo,
// repartiendo la carga entre los tecnicos disponibles (el que tenga menos
// casos "En proceso" en ese momento).
const MINUTOS_ESPERA_ASIGNACION_AUTOMATICA = 5;
const MINUTOS_ESPERA_ASIGNACION_URGENTE = 1; // los casos Urgentes (ej. emergencias) esperan mucho menos

async function asignarTicketsAutomaticamente() {
  try {
    const limiteFechaNormal = new Date(Date.now() - MINUTOS_ESPERA_ASIGNACION_AUTOMATICA * 60 * 1000);
    const limiteFechaUrgente = new Date(Date.now() - MINUTOS_ESPERA_ASIGNACION_URGENTE * 60 * 1000);
    let ticketsSinTomar = await Ticket.find({
      tecnicoAsignado: null,
      estado: { $ne: 'Resuelto' },
      $or: [
        { prioridad: 'Urgente', fechaCreacion: { $lte: limiteFechaUrgente } },
        { prioridad: { $ne: 'Urgente' }, fechaCreacion: { $lte: limiteFechaNormal } }
      ]
    });
    if (ticketsSinTomar.length === 0) return;

    // Se asignan "en orden": primero los mas urgentes, y entre casos de la misma
    // prioridad, primero el que lleva mas tiempo esperando.
    const ORDEN_PRIORIDAD = { Urgente: 0, Alta: 1, Media: 2, Baja: 3 };
    ticketsSinTomar = ticketsSinTomar.sort((a, b) => {
      const diferenciaPrioridad = (ORDEN_PRIORIDAD[a.prioridad] ?? 2) - (ORDEN_PRIORIDAD[b.prioridad] ?? 2);
      if (diferenciaPrioridad !== 0) return diferenciaPrioridad;
      return new Date(a.fechaCreacion) - new Date(b.fechaCreacion);
    });

    const conectados = Object.values(usuariosPorSala[SALA_SOPORTE] || {});
    const tecnicosDisponibles = TECNICOS_AUTORIZADOS.filter((tecnico) =>
      conectados.some((nombreConectado) => normalizarTexto(nombreConectado) === normalizarTexto(tecnico))
    );
    if (tecnicosDisponibles.length === 0) return;

    const activosPorTecnico = {};
    for (const tecnico of tecnicosDisponibles) {
      activosPorTecnico[tecnico] = await Ticket.countDocuments({ tecnicoAsignado: tecnico, estado: 'En proceso' });
    }

    for (const ticket of ticketsSinTomar) {
      const elegido = tecnicosDisponibles.reduce(
        (min, tecnico) => (activosPorTecnico[tecnico] < activosPorTecnico[min] ? tecnico : min),
        tecnicosDisponibles[0]
      );

      ticket.estado = 'En proceso';
      ticket.tecnicoAsignado = elegido;
      ticket.historial.push({ estado: 'En proceso' });
      await ticket.save();
      activosPorTecnico[elegido] += 1;

      const minutosEspera = ticket.prioridad === 'Urgente' ? MINUTOS_ESPERA_ASIGNACION_URGENTE : MINUTOS_ESPERA_ASIGNACION_AUTOMATICA;
      const salaDelTicket = ticket.sala || SALA_SOPORTE;
      const mensajeAsignado = {
        sala: salaDelTicket,
        nombre: NOMBRE_BOT_SOPORTE,
        texto: `🤖 Nadie tomó el ticket #${ticket.numero} en ${minutosEspera} minuto(s), así que se asignó automáticamente a ${elegido} (estaba disponible en el chat). ${ticket.nombre}, ya hay un técnico al tanto de tu caso.`,
        tipo: 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
      };
      await new Mensaje(mensajeAsignado).save();
      io.to(salaDelTicket).emit('mensaje', mensajeAsignado);
      console.log(`Ticket #${ticket.numero} asignado automáticamente a ${elegido}.`);
    }
  } catch (err) {
    console.error('Error asignando tickets automáticamente:', err.message);
  }
}

// ---------- Alerta y asignacion de emergencia por tiempo oficial de atencion (SLA) ----------
// Tiempos oficiales del protocolo del HGM (los mismos que usa el Dashboard).
const SLA_MINUTOS = {
  Incidente: { Urgente: 30, Alta: 60, Media: 120, Baja: 240 },
  Requerimiento: { Urgente: 30, Alta: 60, Media: 480, Baja: 2400 }
};
function obtenerSlaMinutos(ticket) {
  const tipo = SLA_MINUTOS[ticket.tipoServicio] ? ticket.tipoServicio : 'Incidente';
  const prioridad = ticket.prioridad || 'Media';
  return SLA_MINUTOS[tipo][prioridad] ?? SLA_MINUTOS.Incidente.Media;
}

const MINUTOS_AVISO_PREVIO_SLA = 10; // avisa al tecnico asignado cuando falten estos minutos para vencer
const MINUTOS_MARGEN_ASIGNACION_EMERGENCIA = 2; // si sigue sin tomarse, se fuerza la asignacion X minutos despues del aviso

async function revisarAlertasYAsignacionPorSla() {
  try {
    const ticketsActivos = await Ticket.find({ estado: { $ne: 'Resuelto' } });

    for (const ticket of ticketsActivos) {
      const slaMinutos = obtenerSlaMinutos(ticket);
      const minutosTranscurridos = (Date.now() - new Date(ticket.fechaCreacion).getTime()) / (1000 * 60);
      const minutosRestantes = slaMinutos - minutosTranscurridos;
      const salaDelTicket = ticket.sala || SALA_SOPORTE;

      // Caso 1: tiene tecnico asignado, esta por vencer (10 min o menos), y no se le ha avisado todavia
      if (ticket.tecnicoAsignado && !ticket.alertaSlaEnviada && minutosRestantes <= MINUTOS_AVISO_PREVIO_SLA && minutosRestantes > 0) {
        ticket.alertaSlaEnviada = true;
        await ticket.save();

        const mensajeAlerta = {
          sala: `ticket-${ticket.numero}`,
          nombre: NOMBRE_BOT_SOPORTE,
          texto: `⏰ ${ticket.tecnicoAsignado}, este caso #${ticket.numero} está por vencer su tiempo oficial de atención en aproximadamente ${Math.max(0, Math.round(minutosRestantes))} minuto(s). Por favor revísalo.`,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeAlerta).save();
        io.to(`ticket-${ticket.numero}`).emit('mensaje', mensajeAlerta);
        io.to(salaDelTicket).emit('mensaje', mensajeAlerta);
        console.log(`Alerta de SLA enviada para el ticket #${ticket.numero} (tecnico: ${ticket.tecnicoAsignado}).`);
      }

      // Caso 2: NO tiene tecnico asignado, y ya quedan pocos minutos (el margen de emergencia
      // despues del punto en el que se hubiera avisado) -- se fuerza la asignacion ya mismo,
      // sin esperar al ciclo normal de asignarTicketsAutomaticamente.
      const minutosLimiteEmergencia = MINUTOS_AVISO_PREVIO_SLA - MINUTOS_MARGEN_ASIGNACION_EMERGENCIA;
      if (!ticket.tecnicoAsignado && minutosRestantes <= minutosLimiteEmergencia) {
        const conectados = Object.values(usuariosPorSala[SALA_SOPORTE] || {});
        const tecnicosDisponibles = TECNICOS_AUTORIZADOS.filter((tecnico) =>
          conectados.some((nombreConectado) => normalizarTexto(nombreConectado) === normalizarTexto(tecnico))
        );
        if (tecnicosDisponibles.length === 0) continue;

        const activosPorTecnico = {};
        for (const tecnico of tecnicosDisponibles) {
          activosPorTecnico[tecnico] = await Ticket.countDocuments({ tecnicoAsignado: tecnico, estado: 'En proceso' });
        }
        const elegido = tecnicosDisponibles.reduce(
          (min, tecnico) => (activosPorTecnico[tecnico] < activosPorTecnico[min] ? tecnico : min),
          tecnicosDisponibles[0]
        );

        ticket.estado = 'En proceso';
        ticket.tecnicoAsignado = elegido;
        ticket.historial.push({ estado: 'En proceso' });
        await ticket.save();

        const mensajeEmergencia = {
          sala: salaDelTicket,
          nombre: NOMBRE_BOT_SOPORTE,
          texto: `🚨 El ticket #${ticket.numero} está a punto de vencer su tiempo oficial de atención y nadie lo había tomado, así que se asignó de emergencia a ${elegido}. ${ticket.nombre}, ya hay un técnico atendiendo tu caso.`,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeEmergencia).save();
        io.to(salaDelTicket).emit('mensaje', mensajeEmergencia);
        console.log(`Ticket #${ticket.numero} asignado de emergencia a ${elegido} por estar cerca de vencer su SLA.`);
      }
    }
  } catch (err) {
    console.error('Error revisando alertas y asignacion por SLA:', err.message);
  }
}

io.on('connection', (socket) => {
  let salaActual = null;
  let nombreActual = null;
  let ultimaPreguntaFaq = null; // guarda la ultima pregunta que el bot respondio, para crear tickets con contexto
  let areaActual = '';
  let cargoActual = '';
  let extActual = '';

  // El usuario elige nombre y sala al entrar
  socket.on('unirse-sala', async ({ nombre, sala, area, cargo, ext, clave }) => {
    // Si el nombre coincide con un tecnico autorizado, exigimos la misma contraseña
    // que se usa en el Dashboard, para que nadie pueda hacerse pasar por un tecnico
    // con solo escribir su nombre.
    const tecnicoCoincidente = TECNICOS_AUTORIZADOS.find(
      (t) => normalizarTexto(t) === normalizarTexto(nombre || '')
    );
    if (tecnicoCoincidente) {
      try {
        const registroTecnico = await Tecnico.findOne({ nombre: tecnicoCoincidente });
        if (!registroTecnico || !clave || registroTecnico.clave !== clave) {
          socket.emit('error-login', 'Contraseña de técnico incorrecta.');
          return;
        }
        if (!registroTecnico.claveCambiada) {
          socket.emit('debe-cambiar-clave', { nombre: tecnicoCoincidente });
          return;
        }
      } catch (err) {
        console.error('Error verificando la clave del tecnico en el chat:', err.message);
        socket.emit('error-login', 'Ocurrió un error verificando tu contraseña. Intenta de nuevo.');
        return;
      }
      nombre = tecnicoCoincidente; // usamos siempre la ortografia oficial del nombre
    }

    salaActual = sala;
    nombreActual = nombre;
    areaActual = area || '';
    cargoActual = cargo || '';
    extActual = ext || '';
    socket.join(sala);

    if (!usuariosPorSala[sala]) usuariosPorSala[sala] = {};
    usuariosPorSala[sala][socket.id] = nombre;

    // Cargar el historial de esa sala (ultimos 100 mensajes)
    try {
      const historial = await Mensaje.find({ sala }).sort({ fecha: 1 }).limit(100);
      socket.emit('historial', historial);
    } catch (err) {
      console.error('Error cargando historial:', err.message);
      socket.emit('historial', []);
    }

    io.to(sala).emit('lista-usuarios', Object.values(usuariosPorSala[sala]));
    socket.to(sala).emit('mensaje-sistema', `${nombre} se ha unido al chat`);

    // Se une automaticamente a las conversaciones privadas de sus propios tickets,
    // para recibir los mensajes del tecnico sin tener que abrir nada aparte.
    try {
      const misTickets = await Ticket.find({ nombre });
      const conversacionesPrivadas = [];
      for (const t of misTickets) {
        socket.join(`ticket-${t.numero}`);
        const mensajesTicket = await Mensaje.find({ sala: `ticket-${t.numero}` }).sort({ fecha: 1 });
        if (mensajesTicket.length > 0) {
          conversacionesPrivadas.push({ numero: t.numero, estado: t.estado, mensajes: mensajesTicket });
        }
      }
      if (conversacionesPrivadas.length > 0) {
        socket.emit('historial-conversaciones-privadas', conversacionesPrivadas);
      }
    } catch (err) {
      console.error('Error uniendo a las salas de tickets del usuario:', err.message);
    }
  });

  // Mensaje de texto o imagen
  socket.on('mensaje', async (data) => {
    const nuevoMensaje = {
      sala: data.sala,
      nombre: data.nombre,
      texto: data.texto,
      tipo: data.tipo || 'texto',
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
    };

    // Guardar en la base de datos para que quede en el historial
    try {
      const mensajeGuardado = new Mensaje(nuevoMensaje);
      await mensajeGuardado.save();
    } catch (err) {
      console.error('Error guardando mensaje:', err.message);
    }

    io.to(data.sala).emit('mensaje', nuevoMensaje);

    // ---------- Comando /resolver: marca un ticket como resuelto y aprende la solucion ----------
    // Se usa asi, escrito directo en el chat de Soporte Tecnico:
    // /resolver T-4581 La solucion fue reiniciar el switch de red del piso 2.
    if (data.sala === SALA_SOPORTE && /^\/resolver\s+/i.test(data.texto.trim())) {
      if (!esTecnicoAutorizado(data.nombre)) {
        const mensajeSinPermiso = {
          sala: data.sala,
          nombre: NOMBRE_BOT_SOPORTE,
          texto: `${data.nombre}, no tienes permiso para usar este comando. Solo el equipo técnico puede resolver tickets.`,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeSinPermiso).save();
        io.to(data.sala).emit('mensaje', mensajeSinPermiso);
        return;
      }
      const match = data.texto.trim().match(/^\/resolver\s+(\S+)\s+([\s\S]+)$/i);

      if (match) {
        const numeroTicket = match[1].toUpperCase();
        const solucion = match[2].trim();

        try {
          const ticket = await Ticket.findOne({ numero: numeroTicket });

          if (ticket) {
            ticket.estado = 'Resuelto';
            ticket.solucion = solucion;
            if (!ticket.tecnicoAsignado) ticket.tecnicoAsignado = data.nombre;
            ticket.historial.push({ estado: 'Resuelto' });
            await ticket.save();

            const mensajeConfirmacion = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `✅ El técnico marcó el ticket #${numeroTicket} como resuelto.\n\nSolución: ${solucion}\n\n¿Te funcionó? Si la confirmas, escribe: /aprobar ${numeroTicket}`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeConfirmacion).save();
            io.to(data.sala).emit('mensaje', mensajeConfirmacion);
          } else {
            const mensajeError = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `No encontré ningún ticket con el número ${numeroTicket}. Revisa que esté bien escrito.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeError).save();
            io.to(data.sala).emit('mensaje', mensajeError);
          }
        } catch (err) {
          console.error('Error resolviendo ticket:', err.message);
        }
      }
      return; // ya se manejo este mensaje como comando, no seguimos con FAQ/saludo
    }

    // ---------- Comando /aprobar: da el visto bueno final y agrega la solucion a la IA ----------
    // Se usa asi: /aprobar T-4581
    if (data.sala === SALA_SOPORTE && /^\/aprobar\s+/i.test(data.texto.trim())) {
      if (!esTecnicoAutorizado(data.nombre)) {
        const mensajeSinPermiso = {
          sala: data.sala,
          nombre: NOMBRE_BOT_SOPORTE,
          texto: `${data.nombre}, no tienes permiso para usar este comando. Solo el equipo técnico puede aprobar soluciones.`,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeSinPermiso).save();
        io.to(data.sala).emit('mensaje', mensajeSinPermiso);
        return;
      }
      const match = data.texto.trim().match(/^\/aprobar\s+(\S+)/i);

      if (match) {
        const numeroTicket = match[1].toUpperCase();

        try {
          const ticket = await Ticket.findOne({ numero: numeroTicket });

          if (!ticket) {
            const mensajeError = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `No encontré ningún ticket con el número ${numeroTicket}.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeError).save();
            io.to(data.sala).emit('mensaje', mensajeError);
          } else if (ticket.estado !== 'Resuelto' || !ticket.solucion) {
            const mensajeError = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `El ticket #${numeroTicket} todavía no tiene una solución registrada. Primero usa /resolver ${numeroTicket} <la solución>.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeError).save();
            io.to(data.sala).emit('mensaje', mensajeError);
          } else if (ticket.aprobadoParaConocimiento) {
            const mensajeYa = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `El ticket #${numeroTicket} ya había sido aprobado anteriormente.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeYa).save();
            io.to(data.sala).emit('mensaje', mensajeYa);
          } else {
            ticket.aprobadoParaConocimiento = true;
            await ticket.save();

            // Agregamos la solucion aprobada a la base de conocimiento para casos parecidos
            const textoDescripcion = normalizarTexto(ticket.descripcion);
            const palabrasClave = Array.from(new Set(
              [textoDescripcion, ...textoDescripcion.split(' ').filter((palabra) => palabra.length > 3)]
            ));

            preguntasFrecuentes.push({ pregunta: ticket.descripcion, palabrasClave, respuesta: ticket.solucion });

            await new Conocimiento({
              sala: SALA_SOPORTE,
              pregunta: ticket.descripcion,
              palabrasClave,
              respuesta: ticket.solucion,
              ticketOrigen: numeroTicket
            }).save();

            const mensajeAprobado = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `🧠 Solución del ticket #${numeroTicket} aprobada y agregada a la base de conocimiento. A partir de ahora se usará automáticamente para casos parecidos.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeAprobado).save();
            io.to(data.sala).emit('mensaje', mensajeAprobado);
          }
        } catch (err) {
          console.error('Error aprobando ticket:', err.message);
        }
      }
      return;
    }

    // ---------- Comando /tomar: el tecnico avisa que tomo el caso y esta trabajando en el ----------
    // Se usa asi: /tomar T-4586
    if (data.sala === SALA_SOPORTE && /^\/tomar\s+/i.test(data.texto.trim())) {
      if (!esTecnicoAutorizado(data.nombre)) {
        const mensajeSinPermiso = {
          sala: data.sala,
          nombre: NOMBRE_BOT_SOPORTE,
          texto: `${data.nombre}, no tienes permiso para usar este comando. Solo el equipo técnico puede tomar casos.`,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeSinPermiso).save();
        io.to(data.sala).emit('mensaje', mensajeSinPermiso);
        return;
      }
      const match = data.texto.trim().match(/^\/tomar\s+(\S+)/i);

      if (match) {
        const numeroTicket = match[1].toUpperCase();

        try {
          const ticket = await Ticket.findOne({ numero: numeroTicket });

          if (!ticket) {
            const mensajeError = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `No encontré ningún ticket con el número ${numeroTicket}.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeError).save();
            io.to(data.sala).emit('mensaje', mensajeError);
          } else if (ticket.estado === 'Resuelto') {
            const mensajeYa = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `El ticket #${numeroTicket} ya está marcado como resuelto.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeYa).save();
            io.to(data.sala).emit('mensaje', mensajeYa);
          } else {
            ticket.estado = 'En proceso';
            ticket.tecnicoAsignado = data.nombre;
            ticket.historial.push({ estado: 'En proceso' });
            await ticket.save();
            socket.join(`ticket-${numeroTicket}`);

            const mensajeTomado = {
              sala: data.sala,
              nombre: NOMBRE_BOT_SOPORTE,
              texto: `🧑‍💻 ${data.nombre} tomó el ticket #${numeroTicket} y está trabajando en tu caso, ${ticket.nombre}. Te avisamos aquí mismo apenas tengamos una solución.`,
              tipo: 'texto',
              hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            };
            await new Mensaje(mensajeTomado).save();
            io.to(data.sala).emit('mensaje', mensajeTomado);
          }
        } catch (err) {
          console.error('Error tomando ticket:', err.message);
        }
      }
      return;
    }

    // ---------- Respuestas automaticas ----------
    let respuestaBot = null;
    let nombreBot = null;
    let esFaq = false;
    let esRespuestaDeIA = false;
    let preguntaCanonica = null;
    let numeroTicketGenerado = null;
    const textoNormalizado = normalizarTexto(data.texto);

    // Revisamos primero si hay un aviso de "problema conocido" activo que coincida
    // (tiene prioridad sobre las preguntas frecuentes y la IA)
    if (data.tipo === 'texto' && data.sala === SALA_SOPORTE) {
      const avisoEncontrado = await buscarAvisoConocido(textoNormalizado);
      if (avisoEncontrado) {
        respuestaBot = `📢 ${avisoEncontrado.mensaje}`;
        nombreBot = NOMBRE_BOT_SOPORTE;
        esFaq = true; // para que se vea la encuesta 👍👎 y el boton de crear ticket igual
        preguntaCanonica = data.texto;
        ultimaPreguntaFaq = data.texto;
      }
    }

    // Primero revisamos si el mensaje indica que una respuesta anterior no funciono.
    // Esto va ANTES de buscar en las preguntas frecuentes, porque frases como
    // "sigue lento" contienen la misma palabra clave ("lento") que la pregunta
    // original, y no queremos repetir la misma respuesta.
    if (!respuestaBot && data.tipo === 'texto' && (data.sala === SALA_SOPORTE || data.sala === SALA_ASESORIA)
        && frasesInsatisfaccion.some((frase) => textoNormalizado.includes(frase))) {
      try {
        const numeroTicket = await generarNumeroTicket();
        const descripcionTicket = ultimaPreguntaFaq || data.texto;

        await new Ticket({
          numero: numeroTicket,
          categoria: 'Otros',
          descripcion: descripcionTicket,
          nombre: data.nombre,
          area: areaActual,
          cargo: cargoActual,
          extension: extActual,
          sala: data.sala,
          estado: 'En espera',
          historial: [{ estado: 'Creado' }, { estado: 'En espera' }]
        }).save();

        numeroTicketGenerado = numeroTicket;
        const datosTicket = formatoDatosTicket({ area: areaActual, nombre: data.nombre, cargo: cargoActual, extension: extActual, incidencia: descripcionTicket });
        respuestaBot = `Entendido, ${data.nombre}. Se generó el ticket #${numeroTicket}.\n\n${datosTicket}\n\nUn técnico va a contactarte por este mismo chat. Puedes revisar el estado en "Mis tickets" (menú ☰).`;
      } catch (err) {
        console.error('Error creando ticket automatico de escalamiento:', err.message);
        respuestaBot = `Entendido, ${data.nombre}. Un asesor va a contactarte pronto para ayudarte con este tema.`;
      }
      nombreBot = (data.sala === SALA_SOPORTE) ? NOMBRE_BOT_SOPORTE : NOMBRE_BOT_ASESORIA;
    }

    if (!respuestaBot && data.sala === SALA_SOPORTE) {
      const item = buscarPreguntaFaq(preguntasFrecuentes, textoNormalizado);
      if (item) {
        respuestaBot = item.respuesta;
        nombreBot = NOMBRE_BOT_SOPORTE;
        esFaq = true;
        preguntaCanonica = item.pregunta;
        ultimaPreguntaFaq = item.pregunta;
      }
    } else if (!respuestaBot && data.sala === SALA_ASESORIA) {
      const item = buscarPreguntaFaq(preguntasAsesoria, textoNormalizado);
      if (item) {
        respuestaBot = item.respuesta;
        nombreBot = NOMBRE_BOT_ASESORIA;
        esFaq = true;
        preguntaCanonica = item.pregunta;
        ultimaPreguntaFaq = item.pregunta;
      }
    }

    if (!respuestaBot && data.tipo === 'texto' && saludos.includes(textoNormalizado)) {
      respuestaBot = `¡Hola ${data.nombre}! Bienvenido a la sala "${data.sala}". ¿En qué te podemos ayudar hoy?`;
      nombreBot = NOMBRE_BOT_SALUDO;
    }

    // Si nada de lo anterior respondio, probamos con la IA antes de rendirnos
    // (esto tampoco genera un ticket -- solo se responde la pregunta)
    if (!respuestaBot && data.tipo === 'texto' && (data.sala === SALA_SOPORTE || data.sala === SALA_ASESORIA)) {
      const respuestaIA = await preguntarIA(data.texto);

      if (respuestaIA) {
        respuestaBot = respuestaIA;
      } else {
        respuestaBot = `No encontré una respuesta automática para esto, ${data.nombre}. Si el problema continúa, puedes escalarlo a un técnico con el botón 🙋 en el menú ☰.`;
      }

      nombreBot = (data.sala === SALA_SOPORTE) ? NOMBRE_BOT_SOPORTE : NOMBRE_BOT_ASESORIA;
      esFaq = !!respuestaIA; // solo mostramos la encuesta 👍👎 si fue una respuesta real de la IA
      esRespuestaDeIA = !!respuestaIA;
      preguntaCanonica = data.texto;
    }

    if (respuestaBot) {
      setTimeout(async () => {
        const mensajeBot = {
          sala: data.sala,
          nombre: nombreBot,
          texto: respuestaBot,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }),
          esRespuestaFaq: esFaq,
          esRespuestaIA: esRespuestaDeIA,
          preguntaOrigen: esFaq ? preguntaCanonica : null,
          numeroTicket: numeroTicketGenerado
        };
        try {
          const guardado = await new Mensaje(mensajeBot).save();
          mensajeBot._id = guardado._id;
        } catch (err) {
          console.error('Error guardando respuesta del bot:', err.message);
        }
        io.to(data.sala).emit('mensaje', mensajeBot);
      }, 800);
    }
  });

  // El usuario responde la encuesta de satisfaccion (👍 o 👎) de una respuesta del bot
  socket.on('voto-respuesta', async ({ sala, pregunta, voto, nombre, numeroTicket, respuestaTexto }) => {
    try {
      await new Voto({ sala, pregunta, voto, nombre }).save();
    } catch (err) {
      console.error('Error guardando el voto:', err.message);
    }

    // Si el voto fue positivo y hay un ticket asociado, lo cerramos con esa
    // solucion (que ya existia en la base de conocimiento, no hay que aprobarla de nuevo)
    if (voto === 'positivo' && numeroTicket) {
      try {
        const ticket = await Ticket.findOne({ numero: numeroTicket });
        if (ticket && ticket.estado !== 'Resuelto') {
          const listaBusqueda = sala === SALA_SOPORTE ? preguntasFrecuentes : preguntasAsesoria;
          const itemEncontrado = listaBusqueda.find((it) => it.pregunta === pregunta);

          ticket.estado = 'Resuelto';
          ticket.solucion = itemEncontrado ? itemEncontrado.respuesta : (respuestaTexto || 'Confirmado como resuelto por el usuario.');
          ticket.aprobadoParaConocimiento = true; // ya era una solucion conocida, no hace falta /aprobar
          ticket.historial.push({ estado: 'Resuelto' });
          await ticket.save();

          const nombreBotCierre = (sala === SALA_SOPORTE) ? NOMBRE_BOT_SOPORTE : NOMBRE_BOT_ASESORIA;
          const mensajeCierre = {
            sala,
            nombre: nombreBotCierre,
            texto: `✅ El ticket #${numeroTicket} quedó marcado como resuelto (confirmado por ${nombre}).`,
            tipo: 'texto',
            hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
          };
          await new Mensaje(mensajeCierre).save();
          io.to(sala).emit('mensaje', mensajeCierre);
        }
      } catch (err) {
        console.error('Error cerrando ticket por voto positivo:', err.message);
      }
    }

    // Si el voto fue negativo, avisamos que un asesor va a contactar a la persona
    if (voto === 'negativo') {
      const nombreBot = sala === SALA_SOPORTE ? NOMBRE_BOT_SOPORTE
        : sala === SALA_ASESORIA ? NOMBRE_BOT_ASESORIA
        : NOMBRE_BOT_SALUDO;

      const mensajeBot = {
        sala,
        nombre: nombreBot,
        texto: `Entendido, ${nombre}. Un asesor va a contactarte pronto para ayudarte con este tema.`,
        tipo: 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
      };
      try {
        await new Mensaje(mensajeBot).save();
      } catch (err) {
        console.error('Error guardando mensaje de derivacion:', err.message);
      }
      io.to(sala).emit('mensaje', mensajeBot);
    }
  });

  // El usuario crea un ticket nuevo (categoria + descripcion del problema)
  // Si "escalar" es true, el usuario pidio hablar directo con un tecnico,
  // sin que el bot intente responder automaticamente con el FAQ.
  socket.on('crear-ticket', async ({ nombre, sala, categoria, descripcion, escalar, imagenAdjunta, tipoServicio }) => {
    try {
      const numero = await generarNumeroTicket();
      const historial = [{ estado: 'Creado' }];
      const tipoServicioFinal = ['Incidente', 'Requerimiento'].includes(tipoServicio) ? tipoServicio : 'Incidente';
      // La prioridad ya no la elige el usuario (para evitar que todos pongan "Urgente"):
      // la determina la IA segun la descripcion, la categoria y el tipo de servicio.
      const prioridadFinal = await clasificarPrioridadConIA(descripcion, categoria, tipoServicioFinal);

      // Si la descripcion coincide con una pregunta frecuente, damos una respuesta rapida
      // (a menos que el usuario haya pedido escalar directo a un tecnico)
      const textoNormalizado = normalizarTexto(descripcion);
      const item = escalar ? null : buscarPreguntaFaq(preguntasFrecuentes, textoNormalizado);

      let estadoInicial = 'Creado';
      if (escalar) {
        estadoInicial = 'En espera';
        historial.push({ estado: 'En espera' });
      } else if (item) {
        estadoInicial = 'En proceso';
        historial.push({ estado: 'En proceso' });
      }

      const ticketGuardado = await new Ticket({
        numero,
        categoria,
        descripcion,
        prioridad: prioridadFinal,
        tipoServicio: tipoServicioFinal,
        imagenAdjunta: imagenAdjunta || null,
        nombre,
        area: areaActual,
        cargo: cargoActual,
        extension: extActual,
        sala,
        estado: estadoInicial,
        historial
      }).save();

      socket.join(`ticket-${numero}`);
      socket.emit('ticket-creado', ticketGuardado);

      // Anunciamos el ticket en el chat de la sala, con los datos completos
      const iconosPrioridad = { Baja: '🟢', Media: '🟡', Alta: '🟠', Urgente: '🔴' };
      const etiquetaPrioridad = `${iconosPrioridad[prioridadFinal] || '🟡'} Prioridad: ${prioridadFinal} · Tipo: ${tipoServicioFinal}`;
      const datosTicket = formatoDatosTicket({ area: areaActual, nombre, cargo: cargoActual, extension: extActual, incidencia: descripcion });
      const textoAnuncio = escalar
        ? `🙋 ${nombre} solicitó hablar con un técnico. Ticket #${numero} (${categoria}), en espera de atención.\n${etiquetaPrioridad}\n\n${datosTicket}`
        : `🎫 Se creó el ticket #${numero} (${categoria}).\n${etiquetaPrioridad}\n\n${datosTicket}`;

      const mensajeTicket = {
        sala,
        nombre: NOMBRE_BOT_SOPORTE,
        texto: textoAnuncio,
        tipo: 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
      };
      await new Mensaje(mensajeTicket).save();
      io.to(sala).emit('mensaje', mensajeTicket);

      // Si se adjunto una captura, la enviamos tambien como mensaje de imagen en el chat
      if (imagenAdjunta) {
        const mensajeImagen = {
          sala,
          nombre,
          texto: imagenAdjunta,
          tipo: 'imagen',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeImagen).save();
        io.to(sala).emit('mensaje', mensajeImagen);
      }

      // Si encontramos una respuesta automatica para el problema, la enviamos tambien
      if (item) {
        setTimeout(async () => {
          const mensajeBot = {
            sala,
            nombre: NOMBRE_BOT_SOPORTE,
            texto: `Para tu ticket #${numero}, esto puede ayudarte:\n\n${item.respuesta}`,
            tipo: 'texto',
            hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }),
            esRespuestaFaq: true,
            preguntaOrigen: item.pregunta,
            numeroTicket: numero
          };
          const guardado = await new Mensaje(mensajeBot).save();
          mensajeBot._id = guardado._id;
          io.to(sala).emit('mensaje', mensajeBot);
        }, 800);
      }
    } catch (err) {
      console.error('Error creando ticket:', err.message);
    }
  });

  // El usuario pide ver la lista de sus propios tickets
  // ---------- Buzon de sugerencias (cualquier usuario puede enviar) ----------
  socket.on('enviar-sugerencia', async ({ nombre, tecnicoCalificado, calificacion, mensaje }) => {
    try {
      if (!nombre || !mensaje || !mensaje.trim()) return;

      let calificacionFinal = null;
      const numCalificacion = Number(calificacion);
      if (Number.isInteger(numCalificacion) && numCalificacion >= 1 && numCalificacion <= 5) {
        calificacionFinal = numCalificacion;
      }

      let tecnicoFinal = null;
      if (tecnicoCalificado && TECNICOS_AUTORIZADOS.some((t) => normalizarTexto(t) === normalizarTexto(tecnicoCalificado))) {
        tecnicoFinal = TECNICOS_AUTORIZADOS.find((t) => normalizarTexto(t) === normalizarTexto(tecnicoCalificado));
      }

      await new Sugerencia({
        nombre,
        tecnicoCalificado: tecnicoFinal,
        calificacion: calificacionFinal,
        mensaje: mensaje.trim()
      }).save();

      socket.emit('sugerencia-enviada');
    } catch (err) {
      console.error('Error guardando la sugerencia:', err.message);
    }
  });

  // Solo Hector y William David pueden ver el buzon de sugerencias (igual que Reportes)
  socket.on('obtener-sugerencias', async () => {
    if (!puedeVerReportes(nombreActual)) {
      socket.emit('lista-sugerencias', null);
      return;
    }
    try {
      const sugerencias = await Sugerencia.find({}).sort({ fecha: -1 }).limit(100);
      socket.emit('lista-sugerencias', sugerencias);
    } catch (err) {
      console.error('Error obteniendo sugerencias:', err.message);
      socket.emit('lista-sugerencias', []);
    }
  });

  // Cualquier usuario puede pedir la lista de nombres de tecnicos (sin contraseñas),
  // para que el chat sepa a quien pedirle clave al iniciar sesion, y para el buzon
  // de sugerencias -- se mantiene sincronizada con la base de datos automaticamente.
  socket.on('obtener-lista-tecnicos', () => {
    socket.emit('lista-tecnicos-publica', TECNICOS_AUTORIZADOS);
  });

  // ---------- Avisos de problemas conocidos (cualquier tecnico autorizado) ----------
  socket.on('obtener-avisos-conocidos', async () => {
    if (!esTecnicoAutorizado(nombreActual)) {
      socket.emit('lista-avisos-conocidos', null);
      return;
    }
    try {
      const avisos = await AvisoConocido.find({}).sort({ fecha: -1 });
      socket.emit('lista-avisos-conocidos', avisos);
    } catch (err) {
      console.error('Error obteniendo avisos conocidos:', err.message);
      socket.emit('lista-avisos-conocidos', []);
    }
  });

  socket.on('crear-aviso-conocido', async ({ palabrasClave, mensaje }) => {
    if (!esTecnicoAutorizado(nombreActual)) return;
    const palabras = (palabrasClave || '').split(',').map((p) => p.trim()).filter(Boolean);
    const mensajeLimpio = (mensaje || '').trim();
    if (palabras.length === 0 || !mensajeLimpio) {
      socket.emit('resultado-aviso-conocido', { ok: false, error: 'Escribe al menos una palabra clave y el mensaje.' });
      return;
    }
    try {
      await new AvisoConocido({ palabrasClave: palabras, mensaje: mensajeLimpio, creadoPor: nombreActual, activo: true }).save();
      socket.emit('resultado-aviso-conocido', { ok: true, mensaje: 'Aviso creado y activo.' });
    } catch (err) {
      console.error('Error creando aviso conocido:', err.message);
      socket.emit('resultado-aviso-conocido', { ok: false, error: 'Error del servidor.' });
    }
  });

  socket.on('desactivar-aviso-conocido', async ({ id }) => {
    if (!esTecnicoAutorizado(nombreActual)) return;
    try {
      await AvisoConocido.findByIdAndUpdate(id, { activo: false });
      socket.emit('resultado-aviso-conocido', { ok: true, mensaje: 'Aviso desactivado.' });
    } catch (err) {
      console.error('Error desactivando aviso conocido:', err.message);
      socket.emit('resultado-aviso-conocido', { ok: false, error: 'Error del servidor.' });
    }
  });

  // ---------- Respuestas rapidas guardadas (plantillas), cualquier tecnico autorizado ----------
  socket.on('obtener-plantillas', async () => {
    if (!esTecnicoAutorizado(nombreActual)) {
      socket.emit('lista-plantillas', null);
      return;
    }
    try {
      const plantillas = await PlantillaRespuesta.find({}).sort({ fecha: -1 });
      socket.emit('lista-plantillas', plantillas);
    } catch (err) {
      console.error('Error obteniendo plantillas:', err.message);
      socket.emit('lista-plantillas', []);
    }
  });

  socket.on('crear-plantilla', async ({ texto }) => {
    if (!esTecnicoAutorizado(nombreActual)) return;
    const textoLimpio = (texto || '').trim();
    if (!textoLimpio) return;
    try {
      await new PlantillaRespuesta({ texto: textoLimpio, creadoPor: nombreActual }).save();
      socket.emit('resultado-plantilla', { ok: true });
    } catch (err) {
      console.error('Error creando plantilla:', err.message);
      socket.emit('resultado-plantilla', { ok: false, error: 'Error del servidor.' });
    }
  });

  socket.on('eliminar-plantilla', async ({ id }) => {
    if (!esTecnicoAutorizado(nombreActual)) return;
    try {
      await PlantillaRespuesta.findByIdAndDelete(id);
      socket.emit('resultado-plantilla', { ok: true });
    } catch (err) {
      console.error('Error eliminando plantilla:', err.message);
      socket.emit('resultado-plantilla', { ok: false, error: 'Error del servidor.' });
    }
  });

  // ---------- Administrar tecnicos (agregar/quitar), solo Hector y William David ----------
  socket.on('obtener-tecnicos-administrar', async () => {
    if (!puedeVerReportes(nombreActual)) {
      socket.emit('lista-tecnicos-administrar', null);
      return;
    }
    try {
      const registros = await Tecnico.find({}).sort({ nombre: 1 });
      socket.emit('lista-tecnicos-administrar', registros.map((r) => ({ nombre: r.nombre, claveCambiada: r.claveCambiada })));
    } catch (err) {
      console.error('Error obteniendo tecnicos para administrar:', err.message);
      socket.emit('lista-tecnicos-administrar', []);
    }
  });

  socket.on('agregar-tecnico', async ({ nombre }) => {
    if (!puedeVerReportes(nombreActual)) return;
    const nombreLimpio = (nombre || '').trim();
    if (!nombreLimpio) {
      socket.emit('resultado-administrar-tecnico', { ok: false, error: 'Escribe un nombre.' });
      return;
    }
    try {
      const existente = await Tecnico.findOne({ nombre: nombreLimpio });
      if (existente) {
        socket.emit('resultado-administrar-tecnico', { ok: false, error: 'Ya existe un técnico con ese nombre.' });
        return;
      }
      await new Tecnico({ nombre: nombreLimpio, clave: CLAVE_GENERICA_INICIAL, claveCambiada: false }).save();
      await sincronizarListaTecnicos();
      socket.emit('resultado-administrar-tecnico', { ok: true, mensaje: `${nombreLimpio} fue agregado. Su contraseña inicial es: ${CLAVE_GENERICA_INICIAL}` });
    } catch (err) {
      console.error('Error agregando tecnico:', err.message);
      socket.emit('resultado-administrar-tecnico', { ok: false, error: 'Error del servidor.' });
    }
  });

  socket.on('quitar-tecnico', async ({ nombre }) => {
    if (!puedeVerReportes(nombreActual)) return;
    try {
      await Tecnico.deleteOne({ nombre });
      await sincronizarListaTecnicos();
      socket.emit('resultado-administrar-tecnico', { ok: true, mensaje: `${nombre} fue quitado de los técnicos autorizados.` });
    } catch (err) {
      console.error('Error quitando tecnico:', err.message);
      socket.emit('resultado-administrar-tecnico', { ok: false, error: 'Error del servidor.' });
    }
  });

  // Cualquier usuario puede ver que tecnicos estan conectados al chat en este momento
  socket.on('obtener-tecnicos-en-linea', () => {
    const conectados = Object.values(usuariosPorSala[SALA_SOPORTE] || {});
    const tecnicosEnLinea = TECNICOS_AUTORIZADOS.filter((tecnico) =>
      conectados.some((nombreConectado) => normalizarTexto(nombreConectado) === normalizarTexto(tecnico))
    );
    socket.emit('lista-tecnicos-en-linea', tecnicosEnLinea);
  });

  socket.on('obtener-tickets', async ({ nombre }) => {
    try {
      const tickets = await Ticket.find({ nombre }).sort({ fechaCreacion: -1 });
      socket.emit('lista-tickets', tickets);
    } catch (err) {
      console.error('Error obteniendo tickets:', err.message);
      socket.emit('lista-tickets', []);
    }
  });

  // ---------- Calificacion de satisfaccion (solo tickets Resueltos, solo quien lo creo) ----------
  socket.on('calificar-ticket', async ({ numero, nombre, calificacion, comentario }) => {
    try {
      const calificacionNum = Number(calificacion);
      if (!Number.isInteger(calificacionNum) || calificacionNum < 1 || calificacionNum > 5) return;

      const ticket = await Ticket.findOne({ numero });
      if (!ticket) return;
      if (ticket.estado !== 'Resuelto') return;
      if (normalizarTexto(ticket.nombre) !== normalizarTexto(nombre || '')) return;

      ticket.calificacion = calificacionNum;
      ticket.comentarioCalificacion = (comentario || '').trim() || null;
      await ticket.save();

      socket.emit('ticket-calificado', { numero, calificacion: calificacionNum });
    } catch (err) {
      console.error('Error guardando la calificación del ticket:', err.message);
    }
  });

  // ---------- Conversacion privada por ticket ----------
  // Solo puede entrar quien creo el ticket, o un tecnico autorizado (para poder atenderlo).
  async function puedeVerConversacionTicket(numero, nombre) {
    const ticket = await Ticket.findOne({ numero });
    if (!ticket) return null;
    const esCreador = normalizarTexto(ticket.nombre) === normalizarTexto(nombre || '');
    if (!esCreador && !esTecnicoAutorizado(nombre)) return null;
    return ticket;
  }

  socket.on('unirse-conversacion-ticket', async ({ numero, nombre }) => {
    try {
      const ticket = await puedeVerConversacionTicket(numero, nombre);
      if (!ticket) {
        socket.emit('historial-ticket', { numero, mensajes: [], error: 'No tienes acceso a esta conversación.' });
        return;
      }
      const salaTicket = `ticket-${numero}`;
      socket.join(salaTicket);
      const mensajes = await Mensaje.find({ sala: salaTicket }).sort({ fecha: 1 });
      socket.emit('historial-ticket', { numero, mensajes, error: null });
    } catch (err) {
      console.error('Error al unirse a la conversacion del ticket:', err.message);
      socket.emit('historial-ticket', { numero, mensajes: [], error: 'Ocurrió un error al abrir la conversación.' });
    }
  });

  socket.on('mensaje-ticket', async ({ numero, nombre, texto, tipo }) => {
    try {
      const ticket = await puedeVerConversacionTicket(numero, nombre);
      if (!ticket || !texto) return;

      const salaTicket = `ticket-${numero}`;
      const mensaje = {
        sala: salaTicket,
        nombre,
        texto,
        tipo: tipo === 'imagen' ? 'imagen' : 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }),
        numeroTicket: numero
      };
      const guardado = await new Mensaje(mensaje).save();
      mensaje._id = guardado._id;
      io.to(salaTicket).emit('mensaje-ticket', mensaje);

      // Aviso discreto en el chat general de soporte, sin mostrar el contenido, para que
      // un tecnico que no tenga abierta la conversacion sepa que hay actividad en ese ticket.
      if (esTecnicoAutorizado(nombre)) return; // si escribe un tecnico, no hace falta avisar de nuevo
      const aviso = {
        sala: SALA_SOPORTE,
        nombre: NOMBRE_BOT_SOPORTE,
        texto: `💬 ${nombre} escribió en la conversación privada del ticket #${numero}.`,
        tipo: 'texto',
        hora: mensaje.hora
      };
      // Este aviso solo se guarda para los tecnicos que tengan el panel tecnico abierto;
      // no se guarda en la base de datos para no mezclar los historiales.
      io.to(SALA_SOPORTE).emit('aviso-conversacion-ticket', aviso);
    } catch (err) {
      console.error('Error guardando mensaje del ticket:', err.message);
    }
  });

  // ---------- Panel de tecnico ----------
  // Solo tecnicos autorizados pueden pedir la lista completa de tickets (de todos los usuarios)
  socket.on('obtener-todos-tickets', async () => {
    if (!esTecnicoAutorizado(nombreActual)) {
      socket.emit('lista-todos-tickets', []);
      return;
    }
    try {
      const tickets = await Ticket.find({}).sort({ fechaCreacion: -1 });
      socket.emit('lista-todos-tickets', tickets);
    } catch (err) {
      console.error('Error obteniendo todos los tickets:', err.message);
      socket.emit('lista-todos-tickets', []);
    }
  });

  // Tomar un caso desde el boton del panel de tecnico (igual que /tomar por texto)
  socket.on('tomar-ticket-boton', async ({ numero }) => {
    if (!esTecnicoAutorizado(nombreActual) || !salaActual) return;
    try {
      const ticket = await Ticket.findOne({ numero });
      if (!ticket || ticket.estado === 'Resuelto') return;

      ticket.estado = 'En proceso';
      ticket.tecnicoAsignado = nombreActual;
      ticket.historial.push({ estado: 'En proceso' });
      await ticket.save();
      socket.join(`ticket-${numero}`);

      const mensajeTomado = {
        sala: salaActual,
        nombre: NOMBRE_BOT_SOPORTE,
        texto: `🧑‍💻 ${nombreActual} tomó el ticket #${numero} y está trabajando en tu caso, ${ticket.nombre}. Te avisamos aquí mismo apenas tengamos una solución.`,
        tipo: 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
      };
      await new Mensaje(mensajeTomado).save();
      io.to(salaActual).emit('mensaje', mensajeTomado);

      const tickets = await Ticket.find({}).sort({ fechaCreacion: -1 });
      socket.emit('lista-todos-tickets', tickets);
    } catch (err) {
      console.error('Error tomando ticket desde el panel:', err.message);
    }
  });

  // Resolver un caso desde el boton del panel de tecnico (igual que /resolver por texto)
  socket.on('resolver-ticket-boton', async ({ numero, solucion }) => {
    if (!esTecnicoAutorizado(nombreActual) || !salaActual) return;
    if (!solucion || !solucion.trim()) return;
    try {
      const ticket = await Ticket.findOne({ numero });
      if (!ticket) return;

      ticket.estado = 'Resuelto';
      ticket.solucion = solucion.trim();
      if (!ticket.tecnicoAsignado) ticket.tecnicoAsignado = nombreActual;
      ticket.historial.push({ estado: 'Resuelto' });
      await ticket.save();

      const mensajeConfirmacion = {
        sala: salaActual,
        nombre: NOMBRE_BOT_SOPORTE,
        texto: `✅ ${nombreActual} marcó el ticket #${numero} como resuelto.\n\nSolución: ${ticket.solucion}\n\n¿Te funcionó? Si la confirmas, escribe: /aprobar ${numero}`,
        tipo: 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
      };
      await new Mensaje(mensajeConfirmacion).save();
      io.to(salaActual).emit('mensaje', mensajeConfirmacion);

      const tickets = await Ticket.find({}).sort({ fechaCreacion: -1 });
      socket.emit('lista-todos-tickets', tickets);
    } catch (err) {
      console.error('Error resolviendo ticket desde el panel:', err.message);
    }
  });

  // Aprobar una solucion desde el boton del panel de tecnico (igual que /aprobar por texto)
  socket.on('aprobar-ticket-boton', async ({ numero }) => {
    if (!esTecnicoAutorizado(nombreActual) || !salaActual) return;
    try {
      const ticket = await Ticket.findOne({ numero });
      if (!ticket || ticket.estado !== 'Resuelto' || !ticket.solucion || ticket.aprobadoParaConocimiento) return;

      ticket.aprobadoParaConocimiento = true;
      await ticket.save();

      const textoDescripcion = normalizarTexto(ticket.descripcion);
      const palabrasClave = Array.from(new Set(
        [textoDescripcion, ...textoDescripcion.split(' ').filter((palabra) => palabra.length > 3)]
      ));

      preguntasFrecuentes.push({ pregunta: ticket.descripcion, palabrasClave, respuesta: ticket.solucion });

      await new Conocimiento({
        sala: SALA_SOPORTE,
        pregunta: ticket.descripcion,
        palabrasClave,
        respuesta: ticket.solucion,
        ticketOrigen: numero
      }).save();

      const mensajeAprobado = {
        sala: salaActual,
        nombre: NOMBRE_BOT_SOPORTE,
        texto: `🧠 ${nombreActual} aprobó la solución del ticket #${numero}. A partir de ahora se usará automáticamente para casos parecidos.`,
        tipo: 'texto',
        hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
      };
      await new Mensaje(mensajeAprobado).save();
      io.to(salaActual).emit('mensaje', mensajeAprobado);

      const tickets = await Ticket.find({}).sort({ fechaCreacion: -1 });
      socket.emit('lista-todos-tickets', tickets);
    } catch (err) {
      console.error('Error aprobando ticket desde el panel:', err.message);
    }
  });

  // Pide las preguntas que la IA respondio libremente, para que el tecnico revise
  // cuales convertir en preguntas frecuentes oficiales.
  socket.on('obtener-respuestas-ia', async () => {
    if (!esTecnicoAutorizado(nombreActual)) {
      socket.emit('lista-respuestas-ia', []);
      return;
    }
    try {
      const respuestas = await Mensaje.find({ esRespuestaIA: true, sala: SALA_SOPORTE })
        .sort({ fecha: -1 })
        .limit(50);
      socket.emit('lista-respuestas-ia', respuestas);
    } catch (err) {
      console.error('Error obteniendo respuestas de la IA:', err.message);
      socket.emit('lista-respuestas-ia', []);
    }
  });

  // Convierte una respuesta de la IA en una pregunta frecuente oficial
  socket.on('convertir-en-faq', async ({ pregunta, respuesta }) => {
    if (!esTecnicoAutorizado(nombreActual) || !pregunta || !respuesta) return;
    try {
      const textoNormalizadoFaq = normalizarTexto(pregunta);
      const palabrasClave = Array.from(new Set(
        [textoNormalizadoFaq, ...textoNormalizadoFaq.split(' ').filter((palabra) => palabra.length > 3)]
      ));

      preguntasFrecuentes.push({ pregunta, palabrasClave, respuesta });

      await new Conocimiento({
        sala: SALA_SOPORTE,
        pregunta,
        palabrasClave,
        respuesta,
        ticketOrigen: null
      }).save();

      if (salaActual) {
        const mensajeConfirmacion = {
          sala: salaActual,
          nombre: NOMBRE_BOT_SOPORTE,
          texto: `🧠 ${nombreActual} agregó una nueva pregunta frecuente oficial: "${pregunta}".`,
          tipo: 'texto',
          hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        };
        await new Mensaje(mensajeConfirmacion).save();
        io.to(salaActual).emit('mensaje', mensajeConfirmacion);
      }

      socket.emit('faq-convertida', { pregunta });
    } catch (err) {
      console.error('Error convirtiendo respuesta de IA en FAQ:', err.message);
    }
  });

  // Calcula el resumen de metricas para el panel de reportes (solo tecnicos)
  socket.on('obtener-metricas', async () => {
    if (!puedeVerReportes(nombreActual)) {
      socket.emit('metricas', null);
      return;
    }
    try {
      const tickets = await Ticket.find({});
      const totalTickets = tickets.length;
      const resueltos = tickets.filter((t) => t.estado === 'Resuelto');
      const totalResueltos = resueltos.length;
      const totalPendientes = totalTickets - totalResueltos;

      const porEstado = {};
      tickets.forEach((t) => {
        porEstado[t.estado] = (porEstado[t.estado] || 0) + 1;
      });

      const porCategoria = {};
      tickets.forEach((t) => {
        porCategoria[t.categoria] = (porCategoria[t.categoria] || 0) + 1;
      });

      const porTecnico = {};
      resueltos.forEach((t) => {
        const tecnico = t.tecnicoAsignado || 'Sin asignar';
        porTecnico[tecnico] = (porTecnico[tecnico] || 0) + 1;
      });

      // Tiempo promedio de resolucion, calculado desde que se creo hasta que paso a "Resuelto"
      let sumaHoras = 0;
      let contadorConTiempo = 0;
      resueltos.forEach((t) => {
        const entradaResuelto = [...t.historial].reverse().find((h) => h.estado === 'Resuelto');
        if (entradaResuelto) {
          const diffMs = new Date(entradaResuelto.fecha) - new Date(t.fechaCreacion);
          if (diffMs >= 0) {
            sumaHoras += diffMs / (1000 * 60 * 60);
            contadorConTiempo++;
          }
        }
      });
      const tiempoPromedioHoras = contadorConTiempo > 0 ? (sumaHoras / contadorConTiempo) : null;

      // Satisfaccion: solo se cuentan los tickets que el usuario ya califico
      const calificados = resueltos.filter((t) => t.calificacion != null);
      const promedioSatisfaccion = calificados.length > 0
        ? calificados.reduce((suma, t) => suma + t.calificacion, 0) / calificados.length
        : null;

      const sumaPorTecnico = {};
      const conteoPorTecnico = {};
      calificados.forEach((t) => {
        const tecnico = t.tecnicoAsignado || 'Sin asignar';
        sumaPorTecnico[tecnico] = (sumaPorTecnico[tecnico] || 0) + t.calificacion;
        conteoPorTecnico[tecnico] = (conteoPorTecnico[tecnico] || 0) + 1;
      });
      const satisfaccionPorTecnico = {};
      Object.keys(sumaPorTecnico).forEach((tecnico) => {
        satisfaccionPorTecnico[tecnico] = Math.round((sumaPorTecnico[tecnico] / conteoPorTecnico[tecnico]) * 10) / 10;
      });

      socket.emit('metricas', {
        totalTickets,
        totalResueltos,
        totalPendientes,
        porEstado,
        porCategoria,
        porTecnico,
        tiempoPromedioHoras,
        promedioSatisfaccion,
        totalCalificados: calificados.length,
        satisfaccionPorTecnico
      });
    } catch (err) {
      console.error('Error calculando metricas:', err.message);
      socket.emit('metricas', null);
    }
  });

  // Indicador de "escribiendo..."
  socket.on('escribiendo', ({ nombre, sala }) => {
    socket.to(sala).emit('escribiendo', nombre);
  });

  // El usuario le da al boton de "Menu" y sale de la sala sin desconectarse
  socket.on('salir-sala', ({ nombre, sala }) => {
    socket.leave(sala);
    if (usuariosPorSala[sala]) {
      delete usuariosPorSala[sala][socket.id];
      io.to(sala).emit('lista-usuarios', Object.values(usuariosPorSala[sala]));
      io.to(sala).emit('mensaje-sistema', `${nombre} salio del chat`);
    }
    salaActual = null;
    nombreActual = null;
  });

  // Cuando alguien se desconecta
  socket.on('disconnect', () => {
    if (salaActual && usuariosPorSala[salaActual]) {
      delete usuariosPorSala[salaActual][socket.id];
      io.to(salaActual).emit('lista-usuarios', Object.values(usuariosPorSala[salaActual]));
      io.to(salaActual).emit('mensaje-sistema', `${nombreActual} salio del chat`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
