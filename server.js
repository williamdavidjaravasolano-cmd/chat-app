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
  });

  // Indicador de "escribiendo..."
  socket.on('escribiendo', ({ nombre, sala }) => {
    socket.to(sala).emit('escribiendo', nombre);
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
