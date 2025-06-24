// src/middleware/auth.js
const { getAuth } = require('../config/firebase');

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Token de autorización requerido' 
      });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const auth = getAuth();
    
    const decodedToken = await auth.verifyIdToken(idToken);
    req.user = decodedToken;
    
    next();
  } catch (error) {
    console.error('Error de autenticación:', error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    
    return res.status(401).json({ error: 'Token inválido' });
  }
};

module.exports = authMiddleware;

// src/middleware/errorHandler.js
const errorHandler = (error, req, res, next) => {
  console.error('Error:', error);

  // Error de validación de Joi
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Datos inválidos',
      details: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }

  // Error de Firebase
  if (error.code && error.code.startsWith('auth/')) {
    return res.status(401).json({
      error: 'Error de autenticación',
      code: error.code
    });
  }

  // Error de rate limiting
  if (error.status === 429) {
    return res.status(429).json({
      error: 'Demasiadas solicitudes, intenta más tarde'
    });
  }

  // Error por defecto
  res.status(error.status || 500).json({
    error: error.message || 'Error interno del servidor',
    ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
  });