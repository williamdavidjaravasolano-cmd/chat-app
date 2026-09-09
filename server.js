const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir los archivos estaticos de la carpeta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Guardamos usuarios conectados: socket.id -> nombre
const usuariosConectados = {};

io.on('connection', (socket) => {
  console.log('Nueva conexion:', socket.id);

  // Cuando un usuario elige su nombre
  socket.on('nuevo-usuario', (nombre) => {
    usuariosConectados[socket.id] = nombre;
    io.emit('lista-usuarios', Object.values(usuariosConectados));
    socket.broadcast.emit('mensaje-sistema', `${nombre} se ha unido al chat`);
  });

  // Cuando llega un mensaje de un usuario
  socket.on('mensaje', (data) => {
    // Reenviamos el mensaje a TODOS los conectados (incluido el que lo envio)
    io.emit('mensaje', {
      nombre: data.nombre,
      texto: data.texto,
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Indicador de "escribiendo..."
  socket.on('escribiendo', (nombre) => {
    socket.broadcast.emit('escribiendo', nombre);
  });

  // Cuando alguien se desconecta
  socket.on('disconnect', () => {
    const nombre = usuariosConectados[socket.id];
    if (nombre) {
      delete usuariosConectados[socket.id];
      io.emit('lista-usuarios', Object.values(usuariosConectados));
      io.emit('mensaje-sistema', `${nombre} salio del chat`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
