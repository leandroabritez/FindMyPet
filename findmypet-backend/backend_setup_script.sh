#!/bin/bash
# setup.sh - Script de configuración inicial

echo "🚀 Configurando FindMyPet Backend API..."

# Crear estructura de directorios
mkdir -p src/{controllers,models,routes,middleware,services,utils,config}
mkdir -p uploads
mkdir -p logs
mkdir -p tests

echo "📁 Estructura de directorios creada"

# Instalar dependencias
echo "📦 Instalando dependencias..."
npm install

# Copiar archivo de ejemplo de variables de entorno
if [ ! -f .env ]; then
    cp .env.example .env
    echo "⚙️  Archivo .env creado. Por favor, configura las variables."
else
    echo "⚙️  Archivo .env ya existe"
fi

# Crear directorio para logs
mkdir -p logs

echo "✅ Setup completado!"
echo ""
echo "Próximos pasos:"
echo "1. Edita el archivo .env con tus credenciales de Firebase"
echo "2. Configura Redis: docker run -d -p 6379:6379 redis:alpine"
echo "3. Ejecuta: npm run dev"
echo ""

# start.sh - Script de inicio completo
#!/bin/bash
echo "🔥 Iniciando FindMyPet Backend API..."

# Verificar que existe .env
if [ ! -f .env ]; then
    echo "❌ Error: Archivo .env no encontrado"
    echo "Copia .env.example a .env y configura las variables"
    exit 1
fi

# Verificar Redis
echo "🔍 Verificando conexión a Redis..."
if ! redis-cli ping > /dev/null 2>&1; then
    echo "⚠️  Redis no está ejecutándose. Iniciando con Docker..."
    docker run -d -p 6379:6379 --name findmypet-redis redis:alpine
    sleep 3
fi

# Verificar servicios externos
echo "🔍 Verificando servicios externos..."

# AI Service
if ! curl -s http://localhost:8000/health > /dev/null; then
    echo "⚠️  AI Service no está ejecutándose en puerto 8000"
fi

# Scraping Service  
if ! curl -s http://localhost:8001/health > /dev/null; then
    echo "⚠️  Scraping Service no está ejecutándose en puerto 8001"
fi

echo "🚀 Iniciando servidor..."
npm run dev