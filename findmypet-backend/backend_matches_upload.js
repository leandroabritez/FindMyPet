// src/routes/matches.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getFirestore } = require('../config/firebase');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const db = getFirestore();

// GET /api/matches/:petId - Obtener matches de una mascota
router.get('/:petId', authMiddleware, async (req, res) => {
  try {
    const petId = req.params.petId;
    const userId = req.user.uid;
    const { status, limit = 20, offset = 0 } = req.query;

    // Verificar que la mascota pertenece al usuario
    const petDoc = await db.collection('lost_pets').doc(petId).get();
    if (!petDoc.exists || petDoc.data().userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    let query = db.collection('matches')
      .where('petId', '==', petId)
      .orderBy('confidence', 'desc')
      .orderBy('scrapedAt', 'desc');

    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.limit(parseInt(limit)).offset(parseInt(offset)).get();
    
    const matches = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      scrapedAt: doc.data().scrapedAt?.toDate?.()?.toISOString(),
      reviewedAt: doc.data().reviewedAt?.toDate?.()?.toISOString()
    }));

    res.json({
      success: true,
      matches,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: matches.length
      }
    });

  } catch (error) {
    console.error('Error obteniendo matches:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/matches/:matchId/review - Revisar un match (confirmar/rechazar)
router.put('/:matchId/review', authMiddleware, [
  body('status').isIn(['confirmed', 'rejected']).withMessage('Estado debe ser "confirmed" o "rejected"'),
  body('notes').optional().isString().withMessage('Notas deben ser texto')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Datos inválidos', 
        details: errors.array() 
      });
    }

    const matchId = req.params.matchId;
    const userId = req.user.uid;
    const { status, notes } = req.body;

    const matchDoc = await db.collection('matches').doc(matchId).get();
    
    if (!matchDoc.exists) {
      return res.status(404).json({ error: 'Match no encontrado' });
    }

    const matchData = matchDoc.data();

    // Verificar que el match pertenece a una mascota del usuario
    const petDoc = await db.collection('lost_pets').doc(matchData.petId).get();
    if (!petDoc.exists || petDoc.data().userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const updateData = {
      status,
      reviewedAt: new Date(),
      reviewedBy: userId
    };

    if (notes) {
      updateData.reviewNotes = notes;
    }

    await db.collection('matches').doc(matchId).update(updateData);

    // Si se confirma el match, actualizar estadísticas de la mascota
    if (status === 'confirmed') {
      await db.collection('lost_pets').doc(matchData.petId).update({
        lastConfirmedMatch: new Date(),
        confirmedMatchesCount: db.FieldValue.increment(1)
      });
    }

    res.json({
      success: true,
      message: `Match ${status === 'confirmed' ? 'confirmado' : 'rechazado'} exitosamente`
    });

  } catch (error) {
    console.error('Error revisando match:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/matches/stats/:petId - Estadísticas de matches de una mascota
router.get('/stats/:petId', authMiddleware, async (req, res) => {
  try {
    const petId = req.params.petId;
    const userId = req.user.uid;

    // Verificar autorización
    const petDoc = await db.collection('lost_pets').doc(petId).get();
    if (!petDoc.exists || petDoc.data().userId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const matchesSnapshot = await db.collection('matches')
      .where('petId', '==', petId)
      .get();

    const matches = matchesSnapshot.docs.map(doc => doc.data());

    const stats = {
      total: matches.length,
      pending: matches.filter(m => m.status === 'pending').length,
      confirmed: matches.filter(m => m.status === 'confirmed').length,
      rejected: matches.filter(m => m.status === 'rejected').length,
      averageConfidence: matches.length > 0 
        ? Math.round(matches.reduce((sum, m) => sum + m.confidence, 0) / matches.length)
        : 0,
      byPlatform: matches.reduce((acc, match) => {
        acc[match.sourcePlatform] = (acc[match.sourcePlatform] || 0) + 1;
        return acc;
      }, {}),
      lastMatch: matches.length > 0 
        ? Math.max(...matches.map(m => m.scrapedAt?.toDate?.()?.getTime() || 0))
        : null
    };

    if (stats.lastMatch) {
      stats.lastMatch = new Date(stats.lastMatch).toISOString();
    }

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;

// src/routes/upload.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { getStorage } = require('../config/firebase');
const authMiddleware = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const router = express.Router();

// Configuración de multer para archivos en memoria
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo
    files: 5 // máximo 5 archivos
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo JPEG, PNG y WebP.'));
    }
  }
});

// POST /api/upload/images - Subir imágenes de mascotas
router.post('/images', authMiddleware, upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se enviaron archivos' });
    }

    const userId = req.user.uid;
    const bucket = getStorage().bucket();
    const uploadedImages = [];

    for (const file of req.files) {
      try {
        // Procesar imagen con Sharp (redimensionar y optimizar)
        const processedBuffer = await sharp(file.buffer)
          .resize(800, 800, { 
            fit: 'inside', 
            withoutEnlargement: true 
          })
          .jpeg({ 
            quality: 85,
            progressive: true 
          })
          .toBuffer();

        // Generar nombre único
        const fileName = `pets/${userId}/${uuidv4()}.jpg`;
        const fileUpload = bucket.file(fileName);

        // Subir a Firebase Storage
        await fileUpload.save(processedBuffer, {
          metadata: {
            contentType: 'image/jpeg',
            metadata: {
              uploadedBy: userId,
              originalName: file.originalname,
              processedAt: new Date().toISOString()
            }
          }
        });

        // Hacer público el archivo
        await fileUpload.makePublic();

        // URL pública
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

        uploadedImages.push({
          fileName,
          url: publicUrl,
          size: processedBuffer.length,
          originalName: file.originalname
        });

      } catch (uploadError) {
        console.error('Error subiendo archivo:', file.originalname, uploadError);
        // Continuar con los otros archivos
      }
    }

    if (uploadedImages.length === 0) {
      return res.status(500).json({ error: 'Error subiendo todas las imágenes' });
    }

    res.json({
      success: true,
      message: `${uploadedImages.length} imagen(es) subida(s) exitosamente`,
      images: uploadedImages
    });

  } catch (error) {
    console.error('Error en upload:', error);
    
    if (error.message.includes('Tipo de archivo')) {
      return res.status(400).json({ error: error.message });
    }
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Archivo muy grande. Máximo 10MB por imagen.' });
    }
    
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/upload/images/:fileName - Eliminar imagen
router.delete('/images/:fileName', authMiddleware, async (req, res) => {
  try {
    const fileName = req.params.fileName;
    const userId = req.user.uid;

    // Verificar que el archivo pertenece al usuario
    if (!fileName.startsWith(`pets/${userId}/`)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const bucket = getStorage().bucket();
    const file = bucket.file(fileName);

    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    await file.delete();

    res.json({
      success: true,
      message: 'Imagen eliminada exitosamente'
    });

  } catch (error) {
    console.error('Error eliminando imagen:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/upload/images - Listar imágenes del usuario
router.get('/images', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.uid;
    const bucket = getStorage().bucket();

    const [files] = await bucket.getFiles({
      prefix: `pets/${userId}/`,
      maxResults: 100
    });

    const images = await Promise.all(
      files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        return {
          fileName: file.name,
          url: `https://storage.googleapis.com/${bucket.name}/${file.name}`,
          size: parseInt(metadata.size),
          createdAt: metadata.timeCreated,
          contentType: metadata.contentType
        };
      })
    );

    res.json({
      success: true,
      images: images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });

  } catch (error) {
    console.error('Error listando imágenes:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;