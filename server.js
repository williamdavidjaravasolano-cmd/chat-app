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
  fecha: { type: Date, default: Date.now }
});
const Mensaje = mongoose.model('Mensaje', mensajeSchema);

// ---------- Preguntas frecuentes de Soporte Tecnico ----------
// Puedes agregar mas preguntas y respuestas aqui. La pregunta debe escribirse
// EXACTAMENTE igual en el archivo public/index.html (lista listaPreguntasFrecuentes).
const NOMBRE_BOT = 'Soporte Tecnico 🤖';
const SALA_SOPORTE = 'Soporte Tecnico';

const preguntasFrecuentes = {
  'Se me apagó el equipo y no enciende':
    '1. Desconecta el cable de energía del computador.\n' +
    '2. Mantén presionado el botón de encendido (power) durante 15 segundos para liberar la energía estática.\n' +
    '3. Vuelve a conectar el cable de energía.\n' +
    '4. Presiona el botón de encendido (power) — el equipo debería encender normalmente.\n' +
    'Si aún así no enciende, revisa que el cable y el tomacorriente funcionen probando con otro aparato.',

  'Mi computador está muy lento':
    '1. Cierra los programas y pestañas del navegador que no estés usando.\n' +
    '2. Reinicia el equipo por completo (no solo cerrar sesión).\n' +
    '3. Revisa cuánto espacio libre tienes en el disco duro; si está casi lleno, elimina archivos que no uses.\n' +
    '4. Ejecuta el antivirus para descartar programas maliciosos.\n' +
    'Si el problema continúa después de estos pasos, escribe aquí para que un asesor te ayude en detalle.',

  'No tengo conexión a internet o wifi':
    '1. Verifica que el wifi esté activado en tu equipo (icono de wifi en la barra de tareas).\n' +
    '2. Reinicia el router: desconéctalo de la energía, espera 30 segundos y vuelve a conectarlo.\n' +
    '3. Espera 1-2 minutos a que las luces del router se estabilicen.\n' +
    '4. Intenta conectarte de nuevo a la red wifi con la contraseña correcta.\n' +
    'Si otros equipos tampoco tienen internet, es probable que sea un problema del proveedor de internet.',

  'Olvidé mi contraseña de usuario en Windows':
    '1. En la pantalla de inicio de sesión, haz click en "¿Olvidaste tu contraseña?".\n' +
    '2. Sigue las instrucciones para restablecerla usando tu correo o preguntas de seguridad asociadas a la cuenta.\n' +
    '3. Si el equipo no tiene esa opción configurada, se puede necesitar acceso físico al equipo para restablecerla.\n' +
    'Si no logras recuperarla con estos pasos, escribe aquí para que un asesor te guíe con más detalle.'
};

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

    // Si la pregunta coincide con una de soporte tecnico, el bot responde solo
    if (data.sala === SALA_SOPORTE) {
      const pregunta = data.texto.trim();
      const respuesta = preguntasFrecuentes[pregunta];
      if (respuesta) {
        setTimeout(async () => {
          const mensajeBot = {
            sala: data.sala,
            nombre: NOMBRE_BOT,
            texto: respuesta,
            tipo: 'texto',
            hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
          };
          try {
            await new Mensaje(mensajeBot).save();
          } catch (err) {
            console.error('Error guardando respuesta del bot:', err.message);
          }
          io.to(data.sala).emit('mensaje', mensajeBot);
        }, 800);
      }
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
