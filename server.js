const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Aumentamos el tamano maximo de mensaje para poder enviar imagenes (5 MB)
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- API del Dashboard de tickets (herramienta separada del chat) ----------
// Cada tecnico tiene su propio usuario y contraseña. Cambia las contraseñas aqui
// cuando quieras (son las que cada tecnico usa para entrar al dashboard).
const CREDENCIALES_DASHBOARD = {
  'Juan Diego': 'Httxq740*',
  'Juan Pablo': 'Qfuaw255+',
  'Juan Jose': 'Cnbdf487!',
  'Julian': 'Bvgbl004+',
  'Yin Carlos': 'Glqtk846$',
  'William David': 'Oomhf132+',
  'Henrry': 'Cjhyc078*',
  'Hector': 'Hyqmp601+',
  'Kevin Daniel': 'Gcdzh252*'
};

function verificarCredencialesDashboard(req, res, next) {
  const usuario = req.headers['x-dashboard-usuario'];
  const clave = req.headers['x-dashboard-clave'];
  if (!usuario || !CREDENCIALES_DASHBOARD[usuario] || CREDENCIALES_DASHBOARD[usuario] !== clave) {
    return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  }
  req.tecnicoDashboard = usuario;
  next();
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
  fecha: { type: Date, default: Date.now },
  esRespuestaFaq: { type: Boolean, default: false }, // true si es respuesta automatica de una pregunta frecuente
  esRespuestaIA: { type: Boolean, default: false }, // true si la respondio la IA (Groq), no las palabras clave
  preguntaOrigen: { type: String, default: null }, // la pregunta que genero esta respuesta
  numeroTicket: { type: String, default: null } // el ticket relacionado con esta respuesta, si aplica
});
const Mensaje = mongoose.model('Mensaje', mensajeSchema);

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
  historial: [{ estado: String, fecha: { type: Date, default: Date.now } }],
  fechaCreacion: { type: Date, default: Date.now }
});
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
  if (!usuario || !CREDENCIALES_DASHBOARD[usuario] || CREDENCIALES_DASHBOARD[usuario] !== clave) {
    return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  }
  try {
    await new AccesoDashboard({ tecnico: usuario }).save();
  } catch (err) {
    console.error('Error registrando acceso al dashboard:', err.message);
  }
  res.json({ ok: true, tecnico: usuario });
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
// Solo estos nombres (tal como los escriben al entrar al chat) pueden usar
// los comandos /tomar, /resolver y /aprobar. Agrega o quita nombres aqui.
const TECNICOS_AUTORIZADOS = ['Juan Diego', 'Juan Pablo', 'Juan Jose', 'Julian', 'Yin Carlos', 'William David', 'Henrry', 'Hector', 'Kevin Daniel'];

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

// Devuelve la lista completa de tecnicos autorizados, la tengan o no asignados ya
app.get('/api/tecnicos', verificarCredencialesDashboard, (req, res) => {
  res.json(TECNICOS_AUTORIZADOS);
});

// ---------- IA en la nube (Groq, gratis) ----------
// Se usa como respaldo cuando el bot no reconoce la pregunta con palabras clave.
// Funciona siempre, sin depender de que tu PC este prendido.
// GROQ_API_KEY se configura como variable de entorno en Render.
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
            content: 'Eres un asistente de soporte tecnico. Responde en español, de forma breve y clara, usando pasos numerados cuando tenga sentido. No uses mas de 6 pasos.'
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
      return null;
    }
    const datos = await respuesta.json();
    return datos.choices && datos.choices[0] ? datos.choices[0].message.content.trim() : null;
  } catch (err) {
    console.error('Error consultando la IA (Groq):', err.message);
    return null;
  }
}

// ---------- Base de conocimiento aprendida de tickets resueltos ----------
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

io.on('connection', (socket) => {
  let salaActual = null;
  let nombreActual = null;
  let ultimaPreguntaFaq = null; // guarda la ultima pregunta que el bot respondio, para crear tickets con contexto
  let areaActual = '';
  let cargoActual = '';
  let extActual = '';

  // El usuario elige nombre y sala al entrar
  socket.on('unirse-sala', async ({ nombre, sala, area, cargo, ext }) => {
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

    // Primero revisamos si el mensaje indica que una respuesta anterior no funciono.
    // Esto va ANTES de buscar en las preguntas frecuentes, porque frases como
    // "sigue lento" contienen la misma palabra clave ("lento") que la pregunta
    // original, y no queremos repetir la misma respuesta.
    if (data.tipo === 'texto' && (data.sala === SALA_SOPORTE || data.sala === SALA_ASESORIA)
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
  socket.on('crear-ticket', async ({ nombre, sala, categoria, descripcion, escalar, prioridad, imagenAdjunta }) => {
    try {
      const numero = await generarNumeroTicket();
      const historial = [{ estado: 'Creado' }];
      const prioridadFinal = ['Baja', 'Media', 'Alta', 'Urgente'].includes(prioridad) ? prioridad : 'Media';

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
        imagenAdjunta: imagenAdjunta || null,
        nombre,
        area: areaActual,
        cargo: cargoActual,
        extension: extActual,
        sala,
        estado: estadoInicial,
        historial
      }).save();

      socket.emit('ticket-creado', ticketGuardado);

      // Anunciamos el ticket en el chat de la sala, con los datos completos
      const iconosPrioridad = { Baja: '🟢', Media: '🟡', Alta: '🟠', Urgente: '🔴' };
      const etiquetaPrioridad = `${iconosPrioridad[prioridadFinal] || '🟡'} Prioridad: ${prioridadFinal}`;
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
  socket.on('obtener-tickets', async ({ nombre }) => {
    try {
      const tickets = await Ticket.find({ nombre }).sort({ fechaCreacion: -1 });
      socket.emit('lista-tickets', tickets);
    } catch (err) {
      console.error('Error obteniendo tickets:', err.message);
      socket.emit('lista-tickets', []);
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

      socket.emit('metricas', {
        totalTickets,
        totalResueltos,
        totalPendientes,
        porEstado,
        porCategoria,
        porTecnico,
        tiempoPromedioHoras
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
