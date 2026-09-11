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
  preguntaOrigen: { type: String, default: null } // la pregunta que genero esta respuesta
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
      '1. Revisa que el cable de red esté bien conectado, tanto en el computador como en el router.\n' +
      '2. Verifica que el wifi esté activado en tu equipo (icono de wifi en la barra de tareas).\n' +
      '3. Observa si los led (lucecitas) de la CPU o el computador están titilando; si están apagados, revisa que el equipo esté bien conectado a la corriente.\n' +
      '4. Revisa también las luces del router: si están apagadas o en rojo, es probable que el problema sea del servicio de internet, no del computador.\n' +
      'Si después de revisar esto sigues sin conexión, escribe aquí para que un asesor te ayude.'
  },
  {
    pregunta: 'Olvidé mi contraseña de usuario en Windows',
    palabrasClave: ['olvide mi contraseña', 'se me olvido la clave', 'no recuerdo la contraseña', 'perdi la contraseña', 'clave de windows', 'no recuerdo la clave', 'olvide la clave'],
    respuesta:
      '1. Verifica que la tecla "Bloq Mayús" (Caps Lock) no esté activada, ya que esto cambia mayúsculas y minúsculas al escribir la contraseña.\n' +
      '2. Confirma que estás escribiendo el nombre de usuario correcto (a veces hay más de un usuario creado en el mismo equipo).\n' +
      '3. Intenta con las contraseñas que uses habitualmente, por si la escribiste mal o la confundiste con otra.\n' +
      'Si nada de esto funciona, restablecer la contraseña normalmente requiere el acceso de un administrador del equipo. Escribe aquí para que un asesor te ayude directamente.'
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

// ---------- Saludo automatico tipo mesa de ayuda (todas las salas) ----------
const NOMBRE_BOT_SALUDO = 'Mesa de Ayuda 🤖';
const saludos = ['hola', 'holaa', 'holaaa', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'que tal', 'ola', 'buen dia', 'saludos'];

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

  // El usuario elige nombre y sala al entrar
  socket.on('unirse-sala', async ({ nombre, sala }) => {
    salaActual = sala;
    nombreActual = nombre;
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

    // ---------- Respuestas automaticas ----------
    let respuestaBot = null;
    let nombreBot = null;
    let esFaq = false;
    let preguntaCanonica = null;
    const textoNormalizado = normalizarTexto(data.texto);

    if (data.sala === SALA_SOPORTE) {
      const item = buscarPreguntaFaq(preguntasFrecuentes, textoNormalizado);
      if (item) {
        respuestaBot = item.respuesta;
        nombreBot = NOMBRE_BOT_SOPORTE;
        esFaq = true;
        preguntaCanonica = item.pregunta;
      }
    } else if (data.sala === SALA_ASESORIA) {
      const item = buscarPreguntaFaq(preguntasAsesoria, textoNormalizado);
      if (item) {
        respuestaBot = item.respuesta;
        nombreBot = NOMBRE_BOT_ASESORIA;
        esFaq = true;
        preguntaCanonica = item.pregunta;
      }
    }

    if (!respuestaBot && data.tipo === 'texto' && saludos.includes(textoNormalizado)) {
      respuestaBot = `¡Hola ${data.nombre}! Bienvenido a la sala "${data.sala}". ¿En qué te podemos ayudar hoy?`;
      nombreBot = NOMBRE_BOT_SALUDO;
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
          preguntaOrigen: esFaq ? preguntaCanonica : null
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
  socket.on('voto-respuesta', async ({ sala, pregunta, voto, nombre }) => {
    try {
      await new Voto({ sala, pregunta, voto, nombre }).save();
    } catch (err) {
      console.error('Error guardando el voto:', err.message);
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
