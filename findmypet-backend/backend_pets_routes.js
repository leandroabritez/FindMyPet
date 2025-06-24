// src/routes/pets.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getFirestore } = require('../config/firebase');
const authMiddleware = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const router = express.Router();
const db = getFirestore();

// Validaciones para crear mascota
const createPetValidation = [
  body('name').notEmpty().withMessage('Nombre de la mascota es requerido'),
  body('species').isIn(['dog', 'cat']).withMessage('Especie debe ser "dog" o "cat"'),
  body('breed').optional().notEmpty(),
  body('age').optional().isInt({ min: 0, max: 30 }),
  body('description').notEmpty().withMessage('Descripción es requerida'),
  body('images').isArray({ min: 1 }).withMessage('Al menos una imagen es requerida'),
  body('lastSeen.location').notEmpty().withMessage('Ubicación donde se perdió es requerida'),
  body('lastSeen.date').isISO8601().withMessage('Fecha inválida')
];

// GET /api/pets - Obtener mascotas del usuario
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { status, limit = 10, offset = 0 } = req.query;

    let query = db.collection('lost_pets')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc');

    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.limit(parseInt(limit)).offset(parseInt(offset)).get();
    
    const pets = [];
    for (const doc of snapshot.docs) {
      const petData = doc.data();
      
      // Obtener estadísticas de matches para cada mascota
      const matchesSnapshot = await db.collection('matches')
        .where('petId', '==', doc.id)
        .get();

      pets.push({
        id: doc.id,
        ...petData,
        stats: {
          totalMatches: matchesSnapshot.size,
          pendingMatches: matchesSnapshot.docs.filter(m => 
            m.data().status === 'pending'
          ).length
        }
      });
    }

    res.json({
      success: true,
      pets,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: pets.length
      }
    });

  } catch (error) {
    console.error('Error obteniendo mascotas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/pets/:id - Obtener mascota específica
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const petId = req.params.id;
    const userId = req.user.uid;

    const petDoc = await db.collection('lost_pets').doc(petId).get();
    
    if (!petDoc.exists) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    const petData = petDoc.data();
    
    // Verificar que pertenece al usuario
    if (petData.userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Obtener matches recientes
    const matchesSnapshot = await db.collection('matches')
      .where('petId', '==', petId)
      .orderBy('scrapedAt', 'desc')
      .limit(5)
      .get();

    const recentMatches = matchesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      pet: {
        id: petId,
        ...petData,
        recentMatches
      }
    });

  } catch (error) {
    console.error('Error obteniendo mascota:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/pets - Crear nueva búsqueda de mascota
router.post('/', authMiddleware, createPetValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Datos inválidos', 
        details: errors.array() 
      });
    }

    const userId = req.user.uid;
    const petId = uuidv4();
    
    const petData = {
      userId,
      name: req.body.name,
      species: req.body.species,
      breed: req.body.breed || '',
      age: req.body.age || null,
      description: req.body.description,
      images: req.body.images, // URLs de Firebase Storage
      lastSeen: {
        location: req.body.lastSeen.location,
        coordinates: req.body.lastSeen.coordinates || null,
        date: new Date(req.body.lastSeen.date)
      },
      status: 'searching',
      searchConfig: {
        radius: req.body.searchConfig?.radius || 10, // km
        sources: req.body.searchConfig?.sources || ['facebook', 'instagram']
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Guardar en Firestore
    await db.collection('lost_pets').doc(petId).set(petData);

    // Iniciar extracción de características de IA
    try {
      await axios.post(`${process.env.AI_SERVICE_URL}/api/ai/extract-features`, {
        petId,
        images: petData.images
      });
      console.log(`✅ Características de IA extraídas para mascota ${petId}`);
    } catch (aiError) {
      console.error('❌ Error extrayendo características de IA:', aiError.message);
      // No fallar la creación por esto
    }

    // Iniciar scraping job
    try {
      await axios.post(`${process.env.SCRAPING_SERVICE_URL}/api/scraping/start`, {
        petId,
        species: petData.species,
        location: petData.lastSeen.location,
        sources: petData.searchConfig.sources
      });
      console.log(`✅ Scraping iniciado para mascota ${petId}`);
    } catch (scrapingError) {
      console.error('❌ Error iniciando scraping:', scrapingError.message);
      // No fallar la creación por esto
    }

    res.status(201).json({
      success: true,
      message: 'Búsqueda de mascota creada exitosamente',
      pet: {
        id: petId,
        ...petData
      }
    });

  } catch (error) {
    console.error('Error creando mascota:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/pets/:id - Actualizar mascota
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const petId = req.params.id;
    const userId = req.user.uid;

    const petDoc = await db.collection('lost_pets').doc(petId).get();
    
    if (!petDoc.exists) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    const petData = petDoc.data();
    
    if (petData.userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    // No permitir cambiar userId
    delete updateData.userId;
    delete updateData.createdAt;

    await db.collection('lost_pets').doc(petId).update(updateData);

    res.json({
      success: true,
      message: 'Mascota actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error actualizando mascota:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/pets/:id/status - Cambiar estado de búsqueda
router.put('/:id/status', authMiddleware, [
  body('status').isIn(['searching', 'found', 'cancelled']).withMessage('Estado inválido'),
  body('notes').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Datos inválidos', 
        details: errors.array() 
      });
    }

    const petId = req.params.id;
    const userId = req.user.uid;
    const { status, notes } = req.body;

    const petDoc = await db.collection('lost_pets').doc(petId).get();
    
    if (!petDoc.exists) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    const petData = petDoc.data();
    
    if (petData.userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const updateData = {
      status,
      updatedAt: new Date()
    };

    if (notes) {
      updateData.statusNotes = notes;
    }

    if (status === 'found') {
      updateData.foundAt = new Date();
    }

    await db.collection('lost_pets').doc(petId).update(updateData);

    // Detener scraping si se marca como encontrada o cancelada
    if (status !== 'searching') {
      try {
        await axios.post(`${process.env.SCRAPING_SERVICE_URL}/api/scraping/stop/${petId}`);
      } catch (error) {
        console.error('Error deteniendo scraping:', error.message);
      }
    }

    res.json({
      success: true,
      message: `Estado cambiado a "${status}" exitosamente`
    });

  } catch (error) {
    console.error('Error cambiando estado:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/pets/:id - Eliminar búsqueda
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const petId = req.params.id;
    const userId = req.user.uid;

    const petDoc = await db.collection('lost_pets').doc(petId).get();
    
    if (!petDoc.exists) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    const petData = petDoc.data();
    
    if (petData.userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Detener scraping
    try {
      await axios.post(`${process.env.SCRAPING_SERVICE_URL}/api/scraping/stop/${petId}`);
    } catch (error) {
      console.error('Error deteniendo scraping:', error.message);
    }

    // Eliminar matches relacionados
    const matchesSnapshot = await db.collection('matches')
      .where('petId', '==', petId)
      .get();

    const batch = db.batch();
    matchesSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Eliminar la mascota
    batch.delete(db.collection('lost_pets').doc(petId));

    await batch.commit();

    res.json({
      success: true,
      message: 'Búsqueda eliminada exitosamente'
    });

  } catch (error) {
    console.error('Error eliminando mascota:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;