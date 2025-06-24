const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Importar rutas
const authRoutes = require('./src/routes/auth');
const petRoutes = require('./src/routes/pets');
const matchRoutes = require('./src/routes/matches');
const uploadRoutes = require('./src/routes/upload');

// Importar middleware
const errorHandler = require('./src/middleware/errorHandler');
const { initializeFirebase } = require('./src/config/firebase');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar Firebase
initializeFirebase();

// Middleware de seguridad
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://tu-app.com'] 
    : ['http://localhost:19006', 'exp://localhost:19000'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // límite de 100 requests por IP
  message: 'Demasiadas solicitudes, intenta más tarde'
});
app.use('/api/', limiter);

// Middleware general
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir archivos estáticos (uploads)
app.use('/uploads', express.static('uploads'));

// Rutas principales
app.use('/api/auth', authRoutes);
app.use('/api/pets', petRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/upload', uploadRoutes);

// Ruta de salud
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'FindMyPet Backend API'
  });
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({
    message: 'FindMyPet AI Backend API',
    version: '1.0.0',
    docs: '/api/docs'
  });
});

// Middleware de manejo de errores
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  console.log(`📱 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase conectado: ${process.env.FIREBASE_PROJECT_ID}`);
});

module.exports = app;