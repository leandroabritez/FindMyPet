// src/routes/auth.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getAuth, getFirestore } = require('../config/firebase');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const db = getFirestore();

// Validaciones
const registerValidation = [
  body('email').isEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 6 }).withMessage('Password debe tener al menos 6 caracteres'),
  body('name').notEmpty().withMessage('Nombre es requerido'),
  body('phone').optional().isMobilePhone('es-AR').withMessage('Teléfono inválido')
];

const loginValidation = [
  body('email').isEmail().withMessage('Email inválido'),
  body('password').notEmpty().withMessage('Password es requerido')
];

// POST /api/auth/register
router.post('/register', registerValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Datos inválidos', 
        details: errors.array() 
      });
    }

    const { email, password, name, phone, location } = req.body;
    const auth = getAuth();

    // Crear usuario en Firebase Auth
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name
    });

    // Crear perfil en Firestore
    const userProfile = {
      email,
      name,
      phone: phone || null,
      location: location || null,
      createdAt: new Date(),
      isActive: true,
      searchesCount: 0
    };

    await db.collection('users').doc(userRecord.uid).set(userProfile);

    // Generar custom token
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.status(201).json({
      success: true,
      message: 'Usuario registrado exitosamente',
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        name: userProfile.name
      },
      token: customToken
    });

  } catch (error) {
    console.error('Error en registro:', error);
    
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }
    
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/login - Verificar token de Firebase
router.post('/login', async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ error: 'Token requerido' });
    }

    const auth = getAuth();
    const decodedToken = await auth.verifyIdToken(idToken);
    
    // Obtener perfil del usuario
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userProfile = userDoc.data();

    res.json({
      success: true,
      user: {
        uid: decodedToken.uid,
        email: decodedToken.email,
        name: userProfile.name,
        phone: userProfile.phone,
        location: userProfile.location
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    
    if (error.code === 'auth/argument-error') {
      return res.status(400).json({ error: 'Token inválido' });
    }
    
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/auth/profile - Obtener perfil del usuario
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.uid;
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userProfile = userDoc.data();
    
    // Obtener estadísticas
    const petsSnapshot = await db.collection('lost_pets')
      .where('userId', '==', userId)
      .get();

    const stats = {
      totalSearches: petsSnapshot.size,
      activeSearches: petsSnapshot.docs.filter(doc => 
        doc.data().status === 'searching'
      ).length,
      foundPets: petsSnapshot.docs.filter(doc => 
        doc.data().status === 'found'
      ).length
    };

    res.json({
      success: true,
      user: {
        uid: userId,
        email: userProfile.email,
        name: userProfile.name,
        phone: userProfile.phone,
        location: userProfile.location,
        createdAt: userProfile.createdAt,
        stats
      }
    });

  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/auth/profile - Actualizar perfil
router.put('/profile', authMiddleware, [
  body('name').optional().notEmpty().withMessage('Nombre no puede estar vacío'),
  body('phone').optional().isMobilePhone('es-AR').withMessage('Teléfono inválido'),
  body('location.city').optional().notEmpty().withMessage('Ciudad no puede estar vacía'),
  body('location.province').optional().notEmpty().withMessage('Provincia no puede estar vacía')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Datos inválidos', 
        details: errors.array() 
      });
    }

    const userId = req.user.uid;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    await db.collection('users').doc(userId).update(updateData);

    res.json({
      success: true,
      message: 'Perfil actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error actualizando perfil:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;